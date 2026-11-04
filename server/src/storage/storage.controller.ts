import { Controller, Get, Param, Req, Res } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import { TierStatsService } from './tier-stats.service'
import { StorageService } from './storage.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'

/** 简易 MIME 映射（覆盖 ingest/上传产物的常见类型） */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // ---- 成长记忆的音视频（2026-11-02）----
  // 之前只有图片/PDF，录音与视频一律落到 `application/octet-stream`。
  // 微信 <Video> / InnerAudioContext 拿到 octet-stream 时不报错也不播（黑屏/静音），
  // 是「录音点了没反应、视频看不到」的第二个成因（第一个是用了原生标签）。
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
}

/**
 * 存储运维接口。
 *
 * GET /api/storage/tier-stats —— 分层统计（策略 3）
 *   用途一：在云控制台配生命周期规则**前后各调一次**，核对省了多少，而不是只看账单猜；
 *   用途二：容量告警数据源（total.bytes 超过阈值即告警，设计文档 §11.5 第 6 条）。
 *
 * GET /api/storage/files/* —— local 驱动对象读取（本机开发用；supabase 驱动直连对象存储，不经此路由）
 */
@Controller('storage')
export class StorageController {
  constructor(
    private readonly service: TierStatsService,
    private readonly storage: StorageService,
  ) {}

  @Get('tier-stats')
  async tierStats(@Req() req: RequestWithUser) {
    requireUserId(req)
    const data = await this.service.report()
    return { code: 200, msg: 'success', data }
  }

  @Get('files/*')
  async serveFile(@Param('0') key: string, @Res() res: import('express').Response) {
    const localDir =
      process.env.STORAGE_LOCAL_DIR || path.resolve(process.cwd(), '.local-storage')
    // 与 StorageService 相同的逃逸防护
    const norm = path.normalize(key || '').replace(/^(\.\.[/\\])+/, '')
    const abs = path.resolve(localDir, norm)
    if (abs === path.resolve(localDir) || !abs.startsWith(path.resolve(localDir) + path.sep)) {
      res.status(400).json({ code: 400, msg: '非法 key' })
      return
    }
    const ext = path.extname(abs).slice(1).toLowerCase()

    // 1) local 驱动（或本地盘确有该对象）：直接给文件
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      // ⚠️ 不能用 fs.createReadStream(abs).pipe(res)（2026-11-04 修）：
      //    pipe 出来是 `Transfer-Encoding: chunked`，**既没有 Content-Length、
      //    也不支持 Range**（带 Range 请求仍回 200 而不是 206）。
      //    图片和视频封面看不出问题，但微信的 `InnerAudioContext` 靠这两样确定
      //    时长与缓冲窗口 ⇒ 录音点了要么没反应、要么直接 onError。
      //    sendFile 基于 send，会正确处理 Content-Length / Accept-Ranges / 206 分段。
      res.sendFile(abs, {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      }, (err) => {
        // 头已经发出去了就不能再改状态码，只能记录；没发出去才回 500
        if (!err) return
        if (!res.headersSent) res.status(500).json({ code: 500, msg: '读取对象失败' })
        // eslint-disable-next-line no-console
        console.warn('[storage] sendFile 失败', abs, err.message)
      })
      return
    }

    // 2) supabase 驱动代理（2026-10-21）：手机不走跨境直连对象存储，
    //    由本服务端下载后回传——文档/PDF 的 openStorageFile 走此路径。
    const buf = await this.storage.readObject(norm)
    if (!buf) {
      res.status(404).json({ code: 404, msg: '对象不存在' })
      return
    }
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(buf)
  }
}
