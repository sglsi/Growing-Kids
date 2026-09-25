import { Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { UsersService } from '../users/users.service'
import { StorageService } from '../storage/storage.service'

/**
 * 定时维护：
 *  - 清理过期的匿名用户（is_anonymous=true 且 expire_at < now()）
 *  - 连带删除其 subjects/timeline_items/library_docs/documents（由外键 on delete cascade 完成）
 *  - 删除前先收集对象存储 key，删库后异步删文件，避免孤儿文件
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly usersService: UsersService,
    private readonly storageService: StorageService,
  ) {}

  /** 每小时执行一次；匿名用户保留期为 1 天，故每小时的清理足够及时 */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredAnonymous(): Promise<void> {
    try {
      const expired = await this.usersService.listExpiredAnonymous()
      if (!expired.length) return

      const userIds = expired.map((u) => u.id)
      console.log(`[maintenance] 发现 ${userIds.length} 个过期匿名用户，开始清理`)

      // 1) 收集待删文件 key（timeline_items + library_docs + documents）
      const keys = await this.collectFileKeys(userIds)

      // 2) 删用户（级联删业务行）
      const removed = await this.usersService.removeByIds(userIds)
      console.log(`[maintenance] 已删除匿名用户 ${removed} 个，关联文件 ${keys.length} 个`)

      // 3) 删除对象存储文件（吞异常，不阻塞）
      for (const key of keys) {
        await this.storageService.deleteObject(key).catch((e) =>
          console.error('[maintenance] 删除对象失败', key, e),
        )
      }
    } catch (e) {
      console.error('[maintenance] 清理任务异常', e)
    }
  }

  private async collectFileKeys(userIds: string[]): Promise<string[]> {
    const client = getSupabaseClient()
    const keys: string[] = []

    const [timeline, library, docs] = await Promise.all([
      client.from('timeline_items').select('file_key, thumb_key').in('user_id', userIds),
      client.from('library_docs').select('file_key').in('user_id', userIds),
      client.from('documents').select('file_key').in('user_id', userIds),
    ])

    for (const row of (timeline.data || []) as any[]) {
      if (row.file_key) keys.push(row.file_key)
      if (row.thumb_key) keys.push(row.thumb_key)
    }
    for (const row of (library.data || []) as any[]) {
      if (row.file_key) keys.push(row.file_key)
    }
    for (const row of (docs.data || []) as any[]) {
      if (row.file_key) keys.push(row.file_key)
    }
    return keys
  }
}
