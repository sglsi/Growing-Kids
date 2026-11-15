import {
  Controller, Post, Req, HttpCode, UseInterceptors,
  UploadedFile, BadRequestException, HttpException, HttpStatus,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'
import * as os from 'os'
import * as fs from 'fs'
import { StorageService } from '../storage/storage.service'
import { IngestService } from '../storage/ingest.service'
import { sha256 } from '../storage/image-pipeline'
import { TimelineService } from '../timeline/timeline.service'
import { LibraryService } from '../library/library.service'
import { QuotaService } from '../quota/quota.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import { isOpaqueUploadName } from './upload-name'

const IMAGE_MIME_PREFIX = 'image/'

/**
 * 修正上传文件名的编码（思傅 2026-10-23 修「资料库文档中文名不显示/乱码」）：
 *  - 前端会把真实文件名走 formData.original_name 传上来（encodeURIComponent 过）；
 *  - 其他端/老调用方可能只给 multipart 的 filename 头——HTTP 头的非 ASCII 字节
 *    会被 Node 按 latin1 读入 ⇒「数学试卷.pdf」变「æ•°å­¦è¯•å†.pdf」。
 * 按顺序尝试：百分号解码 → latin1→utf8 回转（带合法性校验，纯 ASCII 原样返回）。
 */
function decodeUploadFileName(raw: string): string {
  if (!raw) return ''
  let s = String(raw)
  // 1) 前端 encodeURIComponent 过（formData.original_name 的约定）
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { s = decodeURIComponent(s) } catch { /* 不是合法百分号编码，保留原值 */ }
  }
  // 2) UTF-8 字节被按 latin1 读入的乱码（典型特征：À-ÿ 区间字符）
  if (/[\u00C0-\u00FF]/.test(s)) {
    try {
      const fixed = Buffer.from(s, 'binary').toString('utf8')
      // 回转结果含替换符说明原串本就是合法 latin1 文本（如法文名），不采用
      if (fixed && !fixed.includes('\uFFFD')) s = fixed
    } catch { /* 保留 */ }
  }
  return s.trim()
}

/**
 * 按魔数识别真实文件类型（与 storage.controller 的 MIME 映射口径保持一致）。
 * 返回标准 MIME，无法识别返回 null。目标：拦截 exe/脚本/HTML 等危险或无关类型，
 * 防存储滥用与潜在的 XSS 载体（未知扩展名经 serveFile 落为 octet-stream，仍应源头拒绝）。
 */
function detectFileType(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null
  const sig = (b: number[]) => b.every((x, i) => buf[i] === x)
  if (sig([0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (sig([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (sig([0x47, 0x49, 0x46, 0x38])) return 'image/gif' // GIF8
  if (sig([0x42, 0x4d])) return 'image/bmp'
  if (sig([0x49, 0x49, 0x2a, 0x00]) || sig([0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  if (sig([0x25, 0x50, 0x44, 0x46])) return 'application/pdf' // %PDF
  if (sig([0x50, 0x4b, 0x03, 0x04])) return 'application/docx' // zip：资料库仅收 docx
  if (sig([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm' // EBML：webm/mka
  if (sig([0x49, 0x44, 0x33])) return 'audio/mpeg' // ID3→mp3
  if (sig([0xff, 0xfb]) || sig([0xff, 0xf3]) || sig([0xff, 0xf2])) return 'audio/mpeg'
  if (sig([0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg'
  if (sig([0x52, 0x49, 0x46, 0x46])) {
    // RIFF 容器：WEBP / WAVE 接受，其余（AVI 等）拒绝
    const sub = buf.slice(8, 12).toString('ascii')
    if (sub === 'WEBP') return 'image/webp'
    if (sub === 'WAVE') return 'audio/wav'
    return null
  }
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    // ISO BMFF：MP4 / MOV / M4A
    const brand = buf.slice(8, 12).toString('ascii')
    if (brand.startsWith('M4A') || brand.startsWith('M4V')) return 'audio/mp4'
    return 'video/mp4'
  }
  return null
}

function assertAllowedFileType(buffer: Buffer): void {
  const t = detectFileType(buffer)
  if (!t) {
    throw new BadRequestException(
      '不支持的文件类型：仅允许图片(PNG/JPEG/GIF/WebP/BMP/TIFF)、PDF、Word(docx)、常见音频与视频',
    )
  }
}

@Controller('upload')
export class UploadController {
  constructor(
    private readonly storageService: StorageService,
    private readonly ingestService: IngestService,
    private readonly timelineService: TimelineService,
    private readonly libraryService: LibraryService,
    private readonly quotaService: QuotaService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      // P2 性能/安全：改 diskStorage —— 大文件先落临时盘再读入，避免 20MB 全量缓冲进
      // 进程内存（并发上传叠无频控曾是内存 DoS 面）。读入后即删临时文件防磁盘堆积。
      storage: diskStorage({
        destination: os.tmpdir(),
        filename: (_req, _file, cb) =>
          cb(null, `gk-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(@Req() req: RequestWithUser, @UploadedFile() file: Express.Multer.File) {
    const userId = requireUserId(req)
    if (!file) {
      throw new BadRequestException('未接收到文件（字段名必须为 file）')
    }
    let buffer: Buffer
    if (file.buffer) {
      // diskStorage 下不会走此分支，保留以兼容潜在的其他 storage 策略
      buffer = file.buffer
    } else if (file.path) {
      try {
        buffer = await fs.promises.readFile(file.path)
      } finally {
        // 读入后立即删除临时文件，避免磁盘堆积（diskStorage 不会自动清理）
        await fs.promises.unlink(file.path).catch(() => {})
      }
    } else {
      throw new BadRequestException('未接收到文件内容')
    }

    // 文件类型校验：按魔数识别，拒绝可执行文件/脚本/HTML 等非预期类型（防存储滥用与 XSS 载体）
    assertAllowedFileType(buffer)

    const nameParts = file.originalname.split('.')
    const ext = (nameParts.length > 1 ? nameParts.pop()! : 'jpg').toLowerCase()
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const contentType = file.mimetype || 'application/octet-stream'
    const isImage = contentType.startsWith(IMAGE_MIME_PREFIX)

    // purpose=save 才写入「最近题目 / 资料库」；其余（如 AI 处理前的中间上传）仅返回可访问 URL，不落库。
    //
    // ⚠️ 关键修复：purpose 可能来自两处，必须都读——
    //   - query string：`/api/upload?purpose=save`（旧前端写法）
    //   - multipart 表单字段：formData.purpose（新前端写法）
    // 之前只读 req.body.purpose，而前端把 purpose 放在 URL 查询串里（multer 解析
    // multipart 后 req.body 不含它），导致 archive 恒为 false → 图片/文档永不落库，
    // 表现为「点了保存图片提示已保存，但最近题目/资料库中无记录」。
    const q = (req.query || {}) as Record<string, unknown>
    const b = (req.body || {}) as Record<string, unknown>
    const purposeRaw = b.purpose ?? q.purpose ?? ''
    const purpose = String(Array.isArray(purposeRaw) ? purposeRaw[0] : purposeRaw).trim()
    const archive = purpose === 'save' || purpose === '1' || purpose === 'true'

    // archive_to（思傅 2026-10-24：资料库导入图片）：
    // 默认（不传）= 图片进 timeline 收件箱、文档进 library；
    // archive_to=library = 图片也归档到资料库（调用方显式指定目标，
    // 不动默认分流，不影响既有收件箱上传）。
    // 与 purpose 同样双读（query + formData），防中间层丢参数。
    const archiveToRaw = b.archive_to ?? q.archive_to ?? ''
    const archiveTo = String(Array.isArray(archiveToRaw) ? archiveToRaw[0] : archiveToRaw).trim()
    const imageToLibrary = archiveTo === 'library'

    // D-068：资料库文件夹归属。与 purpose 同样双读（query + formData），
    // 只影响 purpose=save 且归档到 library 的分支；不传 = 根目录（旧行为）。
    // 归属校验不在这里做，统一由 LibraryService.create → LibraryFolderService.assertFolder 收口。
    const folderRaw = b.folder_id ?? q.folder_id ?? ''
    const folderId = String(Array.isArray(folderRaw) ? folderRaw[0] : folderRaw).trim() || null

    // 展示名（思傅 2026-10-23）：优先 formData.original_name（前端显式传的用户选中文件的
    // 真实名字，UTF-8 安全），回落 multipart filename 头（微信 uploadFile 默认给的是
    // 临时路径名 tmp_xxx.pdf，且中文会被按 latin1 读成乱码，故必须过 decodeUploadFileName）。
    // 此前直接用 file.originalname ⇒ 资料库文档「不能正常显示中文名称」的根因。
    const origNameRaw = b.original_name ?? q.original_name ?? ''
    const displayName = decodeUploadFileName(String(Array.isArray(origNameRaw) ? origNameRaw[0] : origNameRaw))
      || decodeUploadFileName(file.originalname)
      || ''
    // ── purpose 语义表（新增调用场景务必照此选，选错会多建/少建记录）──
    //   save | 1 | true  → 归档：图片建 timeline(kind=image)、文档建 library 条目；
    //                       配 archive_to=library 时图片也建 library 条目
    //   temp             → 临时：ingestTemp，ref_count=0，24h 后由孤儿 GC 回收
    //   memory           → 持久化但不建条目（成长记忆，key 由 memory_media 关联）
    //   attach 及其他值  → 持久化但不建条目：作为**附件**被别处引用，
    //                      例如错题提取的裁剪图 → 由题目的 content.question_images 引用
    // ⚠️ 附件类上传绝不能写成 save：那会在上传瞬间就多出一条「最近题目」，
    //    随后保存题目又建一条 ⇒ 首页同一道题显示成两行
    //    （思傅 2026-10-21 复测「图文分家」的真正根因，见 handleCropConfirm）。

    // ===== 存储优化管线（复习本与项目设计.md §11.3 策略 1/2/4 + 5②/7）=====
    // 压缩（→WebP+缩略图）→ 内容去重（命中复用，不重复占对象存储）→ 落库。
    // IngestService 内部全程兜底：任何一步失败都会降级为「原样上传」，绝不阻断上传。
    //
    // ===== 配额预检（策略 6）=====
    // 灰度由 QUOTA_MODE 控制：off / shadow / warn 都不阻断；只有 block 才真正拦截。
    // 临时对象（temp）不占用户长期配额 —— 它 24 小时后就回收，用户也不消费它。
    if (purpose !== 'temp') {
      const quota = await this.quotaService.checkUpload(userId, buffer.length)
      if (!quota.allowed) {
        throw new HttpException(
          {
            code: quota.code,
            msg: quota.code === 'QUOTA_COUNT'
              ? '图片张数已达上限，请清理后重试或升级'
              : '存储空间已满，请清理后重试或升级',
            data: {
              used_bytes: quota.usage.usedBytes,
              quota_bytes: quota.usage.quotaBytes,
              used_count: quota.usage.usedCount,
              quota_count: quota.usage.quotaCount,
              tier: quota.usage.tier,
            },
          },
          HttpStatus.PAYLOAD_TOO_LARGE, // 413
        )
      }
    }

    // ⚠️ 分流判据必须是**显式声明** purpose='temp'，不能用「archive 是否为真」代替：
    //   识别链路（整卷识别 / 题答分传 / 文档识别）上传时不带 purpose ⇒ archive=false，
    //   但它们的 key 会写进识别结果的 question_image_keys 被题目正式引用。
    //   若按 archive=false 一律当 temp 回收，24 小时后这些图会被删 ⇒ **已保存的题目图片裂掉**。
    //   所以只有调用方明确声明「这是用完即弃的中间态」才走 temp（策略 5② + 策略 7）；
    //   其余一律走正式路径 —— 宁可多占一份空间，不可误删一张在用图片。
    const isTemp = purpose === 'temp'
    // memory 上传（成长记忆：图片 / 音频 / 视频）走正式存储但不归档到 timeline / library，
    // 仅返回 key/url，由 memory 模块在 addMedia 时把 key 关联到 memory_media。
    const isMemory = purpose === 'memory'

    // ===== #121：同文件去重（业务条目层）=====
    // 物理层早已去重（blob_objects 内容寻址 + 引用计数），但业务条目此前照建不误 ——
    // 同一份文件反复上传时，用户看到的是「同一张图在列表里好几行」。
    //
    // ⚠️ 必须在 ingest **之前**拦截两个原因：
    //   ① 省一次对象存储写入/查询；
    //   ② 更要命的是引用计数：ingest 内部 acquire() 已把 ref_count +1，若本次不建条目，
    //      这次引用就没人认领 ⇒ 计数虚高 ⇒ 全站再没人删这张图时它永远回收不掉。
    //      放在 ingest 之前拦截，压根不会 acquire，计数天然干净。
    // hash 口径与 IngestService 一致：都对**原始字节**算 sha256 ⇒ 同文件恒定同值。
    const contentHash = sha256(buffer)
    if (archive && !isMemory && contentHash) {
      // 图片默认进收件箱；archive_to=library 的图片与文档进资料库（与下方建条目口径一致）
      const target: 'timeline' | 'library' = isImage && !imageToLibrary ? 'timeline' : 'library'
      const hit =
        target === 'timeline'
          ? await this.timelineService.findByHash(userId, contentHash)
          : await this.libraryService.findByHash(userId, contentHash)
      if (hit) {
        // 命中回收站条目 ⇒ 恢复它，而不是再建一条（否则旧的还在回收站里越积越多）
        const restoredItem = hit.inTrash
          ? target === 'timeline'
            ? await this.timelineService.restore(userId, hit.item.id)
            : await this.libraryService.restore(userId, hit.item.id)
          : hit.item
        const item = restoredItem ?? hit.item
        const dup = item as unknown as {
          id: string
          file_key?: string
          thumb_key?: string
          size_bytes?: number
          width?: number
          height?: number
        }
        const dupKey = dup.file_key || ''
        const dupThumb = dup.thumb_key || dupKey
        console.log('[upload] 命中同文件去重，复用已有条目', {
          userId,
          target,
          itemId: dup.id,
          restored: hit.inTrash,
          hash: contentHash.slice(0, 12),
        })
        return {
          code: 200,
          msg: 'success',
          data: {
            key: dupKey,
            url: dupKey ? await this.storageService.getPublicUrl(dupKey) : '',
            thumb_key: dupThumb,
            thumb_url: dupThumb ? await this.storageService.getPublicUrl(dupThumb) : '',
            type: isImage ? 'image' : 'document',
            timeline_id: target === 'timeline' ? dup.id : '',
            library_id: target === 'library' ? dup.id : '',
            size_bytes: dup.size_bytes || 0,
            width: dup.width || undefined,
            height: dup.height || undefined,
            deduped: true, // 物理层：引用同一份对象
            duplicated: true, // 业务层：命中已有条目，本次未新建
            restored: hit.inTrash, // 是否把回收站里的那一份恢复出来
          },
        }
      }
    }

    const ing = isTemp
      ? await this.ingestService.ingestTemp(buffer, contentType)
      : await this.ingestService.ingest(buffer, contentType)
    const key = ing.key
    const fileHash = ing.hash

    let timelineId = ''
    let libraryId = ''

    if (archive && !isMemory) {
      if (isImage && imageToLibrary) {
        // 图片按 archive_to=library 指定归档到资料库（与默认分流并存）
        const doc = await this.libraryService.create(userId, {
          name: displayName || fileName,
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: ing.mimeType,
          width: ing.width || undefined,
          height: ing.height || undefined,
          size_bytes: ing.sizeBytes,
          file_hash: fileHash,
          source: 'upload',
          folder_id: folderId,
        })
        libraryId = doc.id
      } else if (isImage) {
        // 图片 → 统一收件箱（最近题目）
        // 写入 thumb_key / width / height，使列表能走缩略图（此前这些字段恒空 → 列表拉原图）
        const item = await this.timelineService.create(userId, {
          kind: 'image',
          // 标题由服务端统一生成「科目 日期 第N题」（思傅 2026-11-03）：
          // 以前拿上传文件名当标题，微信聊天里选的卷子会把一长串试卷原文塞进列表
          //（如「要求：1.应包含思维导图中的所有信息，可扩展」），多条之间分不清。
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: ing.mimeType,
          width: ing.width || undefined,
          height: ing.height || undefined,
          size_bytes: ing.sizeBytes,
          file_hash: fileHash,
          source: 'album',
        })
        timelineId = item.id
      } else {
        // 文档 → 资料库
        const doc = await this.libraryService.create(userId, {
          name: displayName || fileName,
          file_key: key,
          thumb_key: ing.thumbKey,
          mime_type: ing.mimeType,
          width: ing.width || undefined,
          height: ing.height || undefined,
          size_bytes: ing.sizeBytes,
          file_hash: fileHash,
          source: 'upload',
          folder_id: folderId,
        })
        libraryId = doc.id
      }
    }

    // 落库的上传会改变用量 ⇒ 让配额缓存立即失效（下次重算）
    if (purpose !== 'temp') this.quotaService.invalidate(userId)

    console.log('[upload] 上传成功', {
      userId,
      key,
      purpose,
      archiveTo: imageToLibrary ? 'library' : undefined,
      quotaMode: this.quotaService.mode,
      archive,
      timelineId,
      libraryId,
      optimized: ing.optimized,
      deduped: ing.deduped,
      originalBytes: buffer.length,
      storedBytes: ing.sizeBytes,
      savedPct: buffer.length ? `${(100 - (ing.sizeBytes / buffer.length) * 100).toFixed(1)}%` : '-',
    })
    return {
      code: 200,
      msg: 'success',
      data: {
        key,
        url: await this.storageService.getPublicUrl(key),
        thumb_key: ing.thumbKey,
        thumb_url: await this.storageService.getPublicUrl(ing.thumbKey),
        type: isImage ? 'image' : 'document',
        timeline_id: timelineId,
        library_id: libraryId,
        size_bytes: ing.sizeBytes,
        width: ing.width || undefined,
        height: ing.height || undefined,
        deduped: ing.deduped,
      },
    }
  }
}
