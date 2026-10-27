import { Controller, Get } from '@nestjs/common';
import { AppService } from '@/app.service';
import { cacheBackendInfo } from '@/shared/cache-store';
import { authTokenEnabled } from '@/shared/auth-token';
import { strictTokenEnabled } from '@/shared/user-context';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getRoot(): Record<string, unknown> {
    return {
      status: 'success',
      data: {
        service: '成长学习伙伴后端 (Growing-Kids API)',
        version: 'v4',
        runtime: 'WorkBuddy 托管（开发预览环境，与扣子平台相互独立）',
        time: new Date().toISOString(),
        endpoints: {
          health: '/api/health',
          subjects: '/api/subjects',
          timeline: '/api/timeline/overview',
          library: '/api/library/docs',
          auth: '/api/auth/login',
        },
        note: '这是 API 服务，没有网页首页；以上路径返回 JSON。数据库：Supabase（新加坡区）。AI 识图/搜题与对象存储暂不可用（开发中）。',
      },
    };
  }

  @Get('hello')
  getHello(): { status: string; data: string } {
    return {
      status: 'success',
      data: this.appService.getHello()
    };
  }

  @Get('health')
  getHealth(): { status: string; data: string } {
    return {
      status: 'success',
      data: new Date().toISOString(),
    };
  }

  /**
   * 运行时诊断（运维用，不含任何密钥值）。
   *
   * 为什么单独开一个而不是塞进 /api/health：/api/health 的 `data` 是**时间戳字符串**，
   * 外部拨测脚本靠它判活（health-probe.mjs），改结构会打断巡检。
   *
   * 这里回答三个「用了哪种后端」的问题——它们决定多副本能不能跑：
   *  - cache：memory（单机）/ redis（多实例共享）
   *  - ticketStore：扫码票据落库还是进程内
   *  - strictToken：是否已关闭裸身份头
   */
  @Get('health/runtime')
  getRuntime() {
    const cache = cacheBackendInfo();
    return {
      status: 'success',
      data: {
        time: new Date().toISOString(),
        apiVersions: ['v1', 'v2'],
        cache: { backend: cache.kind, fallbackReason: cache.fallbackReason || undefined },
        ticketStore: process.env.QR_TICKET_STORE || 'auto(db 优先)',
        auth: {
          tokenEnabled: authTokenEnabled(),
          strictToken: strictTokenEnabled(),
        },
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
      },
    };
  }
}
