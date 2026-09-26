import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'

/**
 * 全局异常过滤器
 * ------------------------------------------------------------
 * 业务约定：所有成功响应都是 { code: 200, msg: 'success', data }，
 * 前端 api.ts 统一解包时会读取 body.msg / body.code。
 *
 * 但 NestJS 默认异常过滤器返回的是 { statusCode, message, error }，
 * 与上面的信封不一致 —— 前端读不到 body.msg，只能兜底成
 * 「请求失败(400)」这种看不出原因的信息（登录 400 就是这么被吞掉的）。
 *
 * 这里把所有异常统一成 { code, msg, data: null }，让真实错误原因能透传到前端。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = '服务器内部错误'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'string') {
        message = body
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>
        const msg = b.message
        if (Array.isArray(msg)) {
          message = msg.filter((m) => typeof m === 'string').join('；') || exception.message
        } else if (typeof msg === 'string') {
          message = msg
        } else if (typeof b.msg === 'string') {
          message = b.msg
        } else {
          message = exception.message
        }
      } else {
        message = exception.message
      }
    } else if (exception instanceof Error) {
      message = exception.message || message
    }

    // 业务信封：code 与 http 状态一致；data 置空
    res.status(status).json({
      code: status,
      msg: message,
      data: null,
    })
  }
}
