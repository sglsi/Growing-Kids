// 必须先于其他模块加载：.env 需要在任何读取 process.env 的代码之前进入环境
// （扣子平台由运行时注入 env；自托管/本地运行时必须靠 dotenv 显式加载）
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { AppController } from '@/app.controller';
import * as express from 'express';
import { HttpStatusInterceptor } from '@/interceptors/http-status.interceptor';
import { AllExceptionsFilter } from '@/filters/all-exceptions.filter';

function parsePort(): number {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('-p');
  if (portIndex !== -1 && args[portIndex + 1]) {
    const port = parseInt(args[portIndex + 1], 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }

  // 托管平台（如 WorkBuddy）通过 PORT 注入端口，优先级高于 SERVER_PORT
  const platformPort = parseInt(process.env.PORT || '', 10);
  if (!isNaN(platformPort) && platformPort > 0 && platformPort < 65536) {
    return platformPort;
  }

  const envPort = parseInt(process.env.SERVER_PORT || '', 10);
  if (!isNaN(envPort) && envPort > 0 && envPort < 65536) {
    return envPort;
  }

  return 3000;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
    // 允许前端读取匿名身份回传头
    exposedHeaders: ['X-User-Id'],
  });
  app.setGlobalPrefix('api');
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // 全局拦截器：统一将 POST 请求的 201 状态码改为 200
  app.useGlobalInterceptors(new HttpStatusInterceptor());
  // 全局异常过滤器：5xx/未知异常落盘 server/logs/error-YYYY-MM-DD.log
  // （服务常在另一个终端手动起，默认堆栈只进那个终端的 stdout，跨会话排查看不到）
  app.useGlobalFilters(new AllExceptionsFilter());
  // 1. 开启优雅关闭 Hooks (关键!)
  app.enableShutdownHooks();

  // 2. 原生根路由：Nest 全局前缀 api 不含 /，直接打开托管域名会得到默认 404。
  //    这里绕过 Nest 路由系统挂一个 /，复用 AppController.getRoot() 的服务名片。
  const appController = app.get(AppController);
  app.getHttpAdapter().get('/', (_req, res) => {
    res.json(appController.getRoot());
  });

  // 2. 解析端口
  const port = parsePort();
  // 将实际监听端口注入 env：StorageService(local 驱动) 的 getPublicUrl 需要用它拼
  // 对象公网地址（模块构造早于 listen，无法直接拿到 port）。`-p 3001` 启动时
  // process.env.PORT 未设，不注入的话会回落默认 3000，生成打不开的 URL。
  process.env.SERVER_PORT = String(port);
  try {
    // 显式绑定 0.0.0.0：容器/托管平台要求监听全部网卡，不能只绑 localhost
    await app.listen(port, '0.0.0.0');
    console.log(`Server running on http://0.0.0.0:${port}`);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${port} 被占用，请设置其他 SERVER_PORT 后重试。`);
      process.exit(1);
    } else {
      throw err;
    }
  }
  console.log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
