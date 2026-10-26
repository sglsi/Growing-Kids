import { Module } from '@nestjs/common'
import { ContentCheckService } from './content-check.service'

/**
 * 内容安全基础设施。
 *
 * 目前只有一个 provider：`ContentCheckService`（微信 msgSecCheck v2）。
 * 单独成 module 是为了让「高层业务模块」按需引用，不必关心从哪来；
 * 后续若接图片检测（mediaCheckAsync）、音频检测，也放在这里导出。
 */
@Module({
  providers: [ContentCheckService],
  exports: [ContentCheckService],
})
export class SecurityModule {}
