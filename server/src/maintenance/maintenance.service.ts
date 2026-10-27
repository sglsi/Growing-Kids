import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import { StorageService } from '../storage/storage.service'
import { BlobService } from '../storage/blob.service'

/** 软删后保留多久才真正回收文件（给误删恢复留窗口） */
const SOFT_DELETE_GRACE_MS = 7 * 24 * 3600 * 1000
/** blob ref_count 归零后静止多久才回收（防止上传中途的短暂 0） */
const BLOB_GRACE_MS = 24 * 3600 * 1000

/**
 * 定时维护（复习本与项目设计.md §11.3 策略 5：临时/孤儿文件连带清理）
 *
 * 三类任务：
 *  1) cleanupExpiredAnonymous —— 过期匿名用户，走**引用计数释放**（不再直接删文件，
 *     避免误删与其他用户共享的 blob）
 *  2) releaseSoftDeleted —— 软删超过宽限期的条目，释放其引用的 blob
 *  3) collectOrphanBlobs —— 回收 ref_count=0 且已静止的 blob（真删对象存储 + 清登记）
 *
 * ⚠️ 安全阀：所有「删文件」动作默认 **dry-run**（只记日志不动手）。
 *    确认日志无误后，设 `STORAGE_GC_DRY_RUN=false` 才真正执行。
 *    默认开启是因为：误删不可逆，宁可让用户多看一轮日志。
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name)

  constructor(
    private readonly usersService: UsersService,
    private readonly storageService: StorageService,
    private readonly blobService: BlobService,
  ) {}

  /** dry-run 开关：默认 true（只记账不删） */
  private get dryRun(): boolean {
    return String(process.env.STORAGE_GC_DRY_RUN ?? 'true').toLowerCase() !== 'false'
  }

  /**
   * 每小时执行一次；匿名用户保留期为 1 天，故每小时的清理足够及时。
   *
   * 变更（存储优化）：原来「删用户 → 直接用 key 删文件」。在全局去重下这**会误删**
   * 其他用户还在用的共享 blob。现改为走 BlobService.release()：ref_count 归零的
   * blob 才进入待回收队列，由 collectOrphanBlobs 统一处理。
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredAnonymous(): Promise<void> {
    try {
      const expired = await this.usersService.listExpiredAnonymous()
      if (!expired.length) return

      const userIds = expired.map((u) => u.id)
      this.logger.log(`[maintenance] 发现 ${userIds.length} 个过期匿名用户，开始清理`)

      // 1) 收集这些用户引用的内容 hash（用于释放引用计数）
      const hashes = await this.collectFileHashes(userIds)
      // 1b) 兼容旧数据：file_hash 为空的条目（本功能上线前的老图）无法走引用计数，
      //     按 key 直接删除，否则历史匿名用户的文件会变成永久孤儿。
      const legacyKeys = await this.collectLegacyKeysWithoutHash(userIds)

      // 2) 删用户（级联删业务行）
      const removed = await this.usersService.removeByIds(userIds)
      this.logger.log(
        `[maintenance] 已删除匿名用户 ${removed} 个，关联内容 ${hashes.length} 个，遗留无 hash 文件 ${legacyKeys.length} 个`,
      )

      // 3) 释放引用（归零的 blob 交由孤儿回收任务真删）
      await this.releaseHashes(hashes, '匿名用户清理')

      // 3b) 旧数据按 key 删（无 hash ⇒ 无共享可能，安全）
      if (legacyKeys.length) {
        if (this.dryRun) {
          this.logger.log(`[maintenance][dry-run] 将删除 ${legacyKeys.length} 个遗留文件`)
        } else {
          for (const key of legacyKeys) {
            await this.storageService.deleteObject(key).catch((e) =>
              this.logger.error(`[maintenance] 删除遗留对象失败 ${key} ${e}`),
            )
          }
        }
      }
    } catch (e) {
      this.logger.error(`[maintenance] 清理任务异常 ${e}`)
    }
  }

  /**
   * 软删回收：条目 deleted_at 超过宽限期 → 释放其 blob 引用。
   * 用「已释放过的条目标记」避免重复释放：释放后把 file_hash 置空不好（丢失溯源），
   * 因此这里按「blob_objects.last_ref_at 早于软删时间」间接判断，配合 ref_count 幂等。
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async releaseSoftDeleted(): Promise<void> {
    try {
      const before = new Date(Date.now() - SOFT_DELETE_GRACE_MS).toISOString()
      const client = getSupabaseClient()

      const [timeline, library, docs] = await Promise.all([
        client.from('timeline_items').select('file_hash').not('deleted_at', 'is', null).lt('deleted_at', before).not('file_hash', 'is', null),
        client.from('library_docs').select('file_hash').not('deleted_at', 'is', null).lt('deleted_at', before).not('file_hash', 'is', null),
        client.from('documents').select('file_hash').not('deleted_at', 'is', null).lt('deleted_at', before).not('file_hash', 'is', null),
      ])

      const hashes = [
        ...((timeline.data || []) as { file_hash: string }[]),
        ...((library.data || []) as { file_hash: string }[]),
        ...((docs.data || []) as { file_hash: string }[]),
      ].map((r) => r.file_hash).filter(Boolean)

      // 去重：同一条目可能被多次扫到，但 release 是幂等降计数的，
      // 这里按「每个业务行释放一次」的语义，用 Set 去掉同一 hash 的重复扫描
      const unique = Array.from(new Set(hashes))
      if (!unique.length) return
      this.logger.log(`[maintenance] 软删回收：${unique.length} 个内容待释放引用`)
      await this.releaseHashes(unique, '软删回收')
    } catch (e) {
      this.logger.error(`[maintenance] 软删回收异常 ${e}`)
    }
  }

  /**
   * 孤儿 blob 回收：ref_count=0 且静止超过宽限期 ⇒ 真删对象存储 + 清登记行。
   * 这是唯一真正删文件的地方，也是 dry-run 的主要保护对象。
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async collectOrphanBlobs(): Promise<void> {
    try {
      const candidates = await this.blobService.listCollectable(BLOB_GRACE_MS, 200)
      if (!candidates.length) return

      const totalBytes = candidates.reduce((s, c) => s + (c.size_bytes || 0), 0)
      this.logger.log(
        `[maintenance] 待回收 blob ${candidates.length} 个，约 ${(totalBytes / 1048576).toFixed(2)} MB` +
          (this.dryRun ? '（dry-run，仅记账不删除）' : ''),
      )

      if (this.dryRun) {
        for (const c of candidates.slice(0, 20)) {
          this.logger.log(`[maintenance][dry-run] 将回收 ${c.content_hash.slice(0, 12)}… key=${c.storage_key}`)
        }
        return
      }

      let deleted = 0
      for (const c of candidates) {
        // 删对象存储的**所有派生档**（original/display/thumb）
        const keys = new Set<string>([c.storage_key, ...Object.values((c.variants || {}) as Record<string, string>)])
        let allOk = true
        for (const k of keys) {
          if (!k) continue
          const ok = await this.storageService.deleteObject(k).catch(() => false)
          if (!ok) allOk = false
        }
        // 只有文件删成功（或本就不存在）才清登记行，避免「行没了文件还在」
        if (allOk) {
          await this.blobService.removeRecord(c.content_hash)
          deleted += 1
        } else {
          this.logger.warn(`[maintenance] 文件删除未全部成功，保留登记行待下轮重试：${c.content_hash}`)
        }
      }
      this.logger.log(`[maintenance] 已回收 blob ${deleted}/${candidates.length} 个`)
    } catch (e) {
      this.logger.error(`[maintenance] 孤儿回收异常 ${e}`)
    }
  }

  /** 批量释放引用（内部吞异常，不阻塞主流程） */
  private async releaseHashes(hashes: string[], tag: string): Promise<void> {
    for (const h of hashes) {
      try {
        const { shouldDelete, remaining } = await this.blobService.release(h)
        if (shouldDelete) {
          this.logger.log(`[maintenance][${tag}] ${h.slice(0, 12)}… 引用归零，进入待回收队列`)
        } else {
          this.logger.debug(`[maintenance][${tag}] ${h.slice(0, 12)}… 仍有 ${remaining} 处引用，保留文件`)
        }
      } catch (e) {
        this.logger.warn(`[maintenance][${tag}] 释放引用失败 ${h}: ${e}`)
      }
    }
  }

  /** 收集这些用户引用的内容 hash（原为收集 file_key，去重后需按 hash 释放） */
  private async collectFileHashes(userIds: string[]): Promise<string[]> {
    const client = getSupabaseClient()

    const [timeline, library, docs] = await Promise.all([
      client.from('timeline_items').select('file_hash').in('user_id', userIds),
      client.from('library_docs').select('file_hash').in('user_id', userIds),
      client.from('documents').select('file_hash').in('user_id', userIds),
    ])

    const hashes: string[] = []
    for (const row of (timeline.data || []) as { file_hash: string | null }[]) {
      if (row.file_hash) hashes.push(row.file_hash)
    }
    for (const row of (library.data || []) as { file_hash: string | null }[]) {
      if (row.file_hash) hashes.push(row.file_hash)
    }
    for (const row of (docs.data || []) as { file_hash: string | null }[]) {
      if (row.file_hash) hashes.push(row.file_hash)
    }
    return Array.from(new Set(hashes))
  }

  /**
   * 注销账号 / 删除本人全部数据（OPS-18 `R-合规-03` 第 3 点：数据保留期与「注销即删」）。
   *
   * 为什么单独写一套而不是复用 `cleanupExpiredAnonymous`：匿名清理是**批量、按时间**，
   * 注销是**单个、用户主动、且必须给回执**（用户要知道「删了什么、留了什么」）。
   *
   * ⚠️ 两条非重复约束（这是本方法最容易写错的地方）：
   *  1) **文件层**：只 `blobService.release()` 减引用，绝不按 key 直接删。
   *     同一份内容可能被别的用户引用（内容寻址去重），直接删会把别人的题图删掉。
   *     引用归零的 blob 交给 `collectOrphanBlobs` 统一回收。
   *  2) **识别缓存层 `ocr_results` 一律不动**：表里没有 user_id、键是
   *     sha256(内容|类型|模式|引擎版本)，跨用户共享。用户在别的设备/别的账号
   *     传过同一张图，删他的行就等于把那份**别人也在用**的识别结果打掉。
   *     它只能按「引擎版本升级」或「容量治理」回收，不参与账号删除。
   *
   * 级联说明：subjects / timeline_items / library_docs / documents / memories /
   * memory_media / answer_cache 都有 `on delete cascade`，删 users 行即连带删除；
   * `chat_messages`（user_id 可空、无外键）与 `user_quota`（text 主键、无外键）
   * 必须显式删。
   */
  async purgeUserData(
    userId: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<{
    userId: string
    dryRun: boolean
    blobsTotal: number
    blobsReleased: number
    blobsKeptForOtherUsers: number
    legacyObjectsDeleted: number
    rowsDeleted: Record<string, number>
    ocrResultsKept: number
    note: string
  }> {
    const client = getSupabaseClient()
    const dry = !!(opts.dryRun || this.dryRun)
    const rowsDeleted: Record<string, number> = {}

    // 1) 先收集引用（必须在删行之前——删完就查不到 hash 了）
    //
    // ⚠️ 并行化（2026-10-27 分模块验证发现的 P2 性能问题）：
    //   这两步各自内部已并行，但彼此之间原本是**串行**的，加上后面 3 次 count，
    //   整条链路要串 5 轮跨境 DB 往返。Supabase 新加坡单程 ~1.5~5s ⇒ 空账号实测
    //   26s，真实账号（有题目/图片/记忆）只会更久，逼近小程序端 60s 超时。
    //   它们之间没有数据依赖，合并成一轮。
    const [hashes, legacyKeys] = await Promise.all([
      this.collectFileHashes([userId]),
      this.collectLegacyKeysWithoutHash([userId]),
    ])

    // 6) ocr_results 的留存数量（只读统计，绝不删）
    //    它不依赖任何前序结果，提前发出、最后回收，又省一轮往返
    const ocrKeptPromise = Promise.resolve(
      client.from('ocr_results').select('cache_key', { count: 'exact', head: true }),
    )
      .then((r) => r.count || 0)
      .catch(() => 0)

    // 2) 显式删无级联的表（有级联的交给删 users 行）
    //    同上：两张表互不依赖，并行发出，省一轮往返
    await Promise.all(
      (['chat_messages', 'user_quota'] as const).map(async (table) => {
      if (dry) {
        const { count } = await client
          .from(table)
          .select('user_id', { count: 'exact', head: true })
          .eq('user_id', userId)
        rowsDeleted[table] = count || 0
        return
      }
      const { data, error } = await client.from(table).delete().eq('user_id', userId).select('user_id')
      if (error) {
        this.logger.error(`[purge] 删除 ${table} 失败: ${error.message}`)
        return
      }
      rowsDeleted[table] = (data || []).length
      }),
    )

    // 3) 删 users 行（级联清业务表）
    if (!dry) {
      const removed = await this.usersService.removeByIds([userId])
      rowsDeleted.users = removed
    } else {
      rowsDeleted.users = 1
    }

    // 4) 释放 blob 引用（归零的进待回收队列，不在这里删文件）
    let released = 0
    let kept = 0
    if (!dry) {
      for (const h of hashes) {
        try {
          const { shouldDelete, remaining } = await this.blobService.release(h)
          if (shouldDelete) released++
          else if (remaining > 0) kept++
        } catch (e) {
          this.logger.warn(`[purge] 释放引用失败 ${h.slice(0, 12)}…: ${e}`)
        }
      }
    }

    // 5) 旧数据（无 hash）按 key 删——没有共享可能，安全
    let legacyDeleted = 0
    if (!dry) {
      for (const key of legacyKeys) {
        try {
          await this.storageService.deleteObject(key)
          legacyDeleted++
        } catch (e) {
          this.logger.warn(`[purge] 删除遗留对象失败 ${key}: ${e}`)
        }
      }
    }

    // 6) ocr_results 的留存数量（只读统计，绝不删）—— 已在开头并行发起，这里回收
    const ocrKept = await ocrKeptPromise

    const note =
      '账号与本人业务数据已删除；共享文件按引用计数处理（其他用户仍在引用则保留），' +
      '识别结果缓存 ocr_results 为跨用户共享的内容寻址缓存，不随账号删除。'
    this.logger.log(
      `[purge] userId=${userId} dryRun=${dry} blobs=${hashes.length}(释放${released}/他人在用${kept}) ` +
        `legacy=${legacyDeleted}/${legacyKeys.length} rows=${JSON.stringify(rowsDeleted)}`,
    )
    return {
      userId,
      dryRun: dry,
      blobsTotal: hashes.length,
      blobsReleased: released,
      blobsKeptForOtherUsers: kept,
      legacyObjectsDeleted: legacyDeleted,
      rowsDeleted,
      ocrResultsKept: ocrKept,
      note,
    }
  }

  /** 收集「file_hash 为空」的旧数据对象 key —— 这些无法走引用计数，按 key 直接删 */
  private async collectLegacyKeysWithoutHash(userIds: string[]): Promise<string[]> {
    const client = getSupabaseClient()
    const keys: string[] = []
    const [timeline, library, docs] = await Promise.all([
      client.from('timeline_items').select('file_key, thumb_key').in('user_id', userIds).is('file_hash', null),
      client.from('library_docs').select('file_key, thumb_key').in('user_id', userIds).is('file_hash', null),
      client.from('documents').select('file_key').in('user_id', userIds).is('file_hash', null),
    ])
    for (const row of (timeline.data || []) as { file_key: string; thumb_key: string | null }[]) {
      if (row.file_key) keys.push(row.file_key)
      if (row.thumb_key) keys.push(row.thumb_key)
    }
    for (const row of (library.data || []) as { file_key: string; thumb_key: string | null }[]) {
      if (row.file_key) keys.push(row.file_key)
      if (row.thumb_key) keys.push(row.thumb_key)
    }
    for (const row of (docs.data || []) as { file_key: string }[]) {
      if (row.file_key) keys.push(row.file_key)
    }
    return Array.from(new Set(keys))
  }
}
