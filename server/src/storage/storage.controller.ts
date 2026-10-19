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
}

/**
 * 存储运维接口。
 *
 * GET /api/storage/tier-stats —— 分层统计（策略 3）
 *   用途一：在云控制台配生命周期规则**前后各调一次**，核对省了多少，而不是只看账单猜；
 *   用途二：容量告警数据源（total.bytes 超过阈值即告警，设计文档 §11.5 第 6 条）。
 *
 * GET /api/storage/files/* —— local 驱动对象读取（本机开发用；coze 驱动走预签名 URL，不经此路由）
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
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ code: 404, msg: '对象不存在' })
      return
    }
    const ext = path.extname(abs).slice(1).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    fs.createReadStream(abs).pipe(res)
  }
}
