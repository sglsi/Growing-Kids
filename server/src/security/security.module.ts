import { Module } from '@nestjs/common'
import { ContentCheckService } from './content-check.service'
import { UgcTextGuard } from './ugc-text-guard.service'

/**
 * 内容安全基础设施。
 *
 * Provider：
 *  · `ContentCheckService` —— 微信 msgSecCheck v2 封装（D-059 前只被 chat 调用）
 *  · `UgcTextGuard`        —— D-059：用户可编辑文本入库前的统一闸门，供
 *    auth / timeline / memory / questions / subjects 复用。
 *
 * 单独成 module 是为了让「高层业务模块」按需引用，不必关心从哪来；
 * 后续若接图片检测（mediaCheckAsync）、音频检测，也放在这里导出。
 */
@Module({
  providers: [ContentCheckService, UgcTextGuard],
  exports: [ContentCheckService, UgcTextGuard],
})
export class SecurityModule {}
