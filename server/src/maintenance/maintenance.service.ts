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
