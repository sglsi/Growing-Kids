import { Controller, Get } from '@nestjs/common';
import { AppService } from '@/app.service';

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
}
