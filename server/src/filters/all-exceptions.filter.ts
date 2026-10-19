// ============================================================
// 全局异常过滤器：未捕获异常落盘
//
// 背景（2026-10-19 用户实测）：小程序调 /api/image/ocr-page 返回
// `500 Internal server error`，但服务是用户在另一个终端手动
// `npm run dev` 起的，NestJS 默认只把堆栈打到那个终端的
// stdout——排查者（与运行终端不是同一人/同一会话）根本看不到，
// 只能对着「Internal server error」猜。
//
// 本过滤器把 5xx / 未知异常写进 server/logs/error-YYYY-MM-DD.log：
//   - 时间、HTTP 方法、URL、userId、请求体摘要、错误消息、完整堆栈
//   - 4xx（BadRequest/Unauthorized 等业务正常返回）不记录，避免刷爆磁盘
//   - 按天分文件；单文件超 5MB 自动换号（error-YYYY-MM-DD.2.log…）
//
// 日志目录已在 .gitignore（/server/logs/），不会进仓库。
// ============================================================

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/** 单文件最大字节数（超过则换号续写） */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 请求体落盘的最大字符数（防止把 50mb base64 全写进日志） */
const MAX_BODY_CHARS = 2000;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');
  private readonly logDir: string;
  /** 今天已用的文件路径（按日期缓存，避免每次异常都拼路径/翻目录） */
  private currentFile: string | null = null;
  private currentDay: string = '';

  constructor(logDir?: string) {
    this.logDir = logDir || path.resolve(process.cwd(), 'logs');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // 4xx：业务正常返回（参数错误/未登录/配额超限等）——不落盘，但响应仍要由本过滤器发。
    // ⚠️ 曾经在这里提前 return（以为「交给 Nest 默认行为」），但 useGlobalFilters
    // 注册后 Nest 的 BaseExceptionFilter 已被替换，没人发响应 ⇒ 请求挂起直至客户端
    // 超时（curl 实测 HTTP:000）。所有异常统一走下面的响应逻辑。
    const skipLog = status < 500;

    const entry = this.formatEntry(exception, req, status);

    // 双写：终端（保持原行为，用户/运维能在启动终端看到）+ 文件（跨会话排查用）
    // 仅 5xx/未知异常落盘；4xx 是业务正常返回，只打终端不写文件。
    this.logger.error(entry.oneLine);
    if (!skipLog) this.writeToFile(entry.detail);

    // 响应体双写：
    //  - code/msg：项目统一信封（前端 unwrapResponse 只读 body.msg，
    //    Nest 默认的 { statusCode, message } 没有 msg 字段，导致后端抛出的
    //    详细文案前端永远收不到，只能显示「识别服务异常(500）」——2026-10-19 实测确认）
    //  - statusCode/message/error：Nest 默认形态，保持向后兼容
    if (!res.headersSent) {
      const msg = this.messageOf(exception as HttpException) || 'Internal server error';
      res.status(status).json({
        code: status,
        msg,
        statusCode: status,
        message: msg,
        error: exception instanceof HttpException ? exception.name.replace('Exception', '') : 'Internal Server Error',
      });
    }
  }

  private messageOf(e: unknown): string {
    if (!(e instanceof HttpException)) {
      return e instanceof Error ? e.message : String(e);
    }
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
      const m = (r as { message?: unknown }).message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m) && m.length) return String(m[0]);
    }
    return e.message;
  }

  private formatEntry(
    exception: unknown,
    req: Request,
    status: number,
  ): { oneLine: string; detail: string } {
    const now = new Date();
    const isHttp = exception instanceof HttpException;
    const message = this.messageOf(exception);
    const stack =
      exception instanceof Error && exception.stack
        ? exception.stack
        : '(无堆栈)';
    const userId = (req as Request & { userId?: string }).userId ?? '-';
    const body = this.safeBody(req);

    const oneLine = `[${req.method} ${req.originalUrl || req.url}] ${status} ${message}`;
    const detail = [
      `===== ${now.toISOString()} =====`,
      `status: ${status}`,
      `method: ${req.method}`,
      `url: ${req.originalUrl || req.url}`,
      `userId: ${userId}`,
      `ip: ${req.ip || '-'}`,
      `body: ${body}`,
      `message: ${message}`,
      `stack:`,
      stack,
      '',
    ].join('\n');
    return { oneLine, detail };
  }

  private safeBody(req: Request): string {
    try {
      const b = (req as Request & { body?: unknown }).body;
      if (!b || (typeof b === 'object' && Object.keys(b).length === 0)) return '(empty)';
      const s = JSON.stringify(b, (_k, v) =>
        typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + `…(共${v.length}字符)` : v,
      );
      return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + '…(截断)' : s;
    } catch {
      return '(不可序列化)';
    }
  }

  private writeToFile(detail: string): void {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.currentDay || !this.currentFile) {
        this.currentDay = day;
        this.currentFile = this.pickFile(day);
      }
      fs.appendFileSync(this.currentFile!, detail);
    } catch (e) {
      // 日志写不出去不能影响响应：仅终端告警
      this.logger.warn(`异常日志落盘失败: ${(e as Error).message}`);
    }
  }

  /** 选当天可写的文件：主文件超限则用 .2/.3… 续号 */
  private pickFile(day: string): string {
    const base = path.join(this.logDir, `error-${day}.log`);
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const st = fs.statSync(base);
      if (st.size < MAX_FILE_BYTES) return base;
    } catch {
      return base; // 不存在 → 直接新建
    }
    for (let i = 2; i < 100; i++) {
      const f = path.join(this.logDir, `error-${day}.${i}.log`);
      try {
        if (fs.statSync(f).size < MAX_FILE_BYTES) return f;
      } catch {
        return f;
      }
    }
    return base;
  }
}
