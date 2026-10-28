// 必须先于其他模块加载：.env 需要在任何读取 process.env 的代码之前进入环境
// （扣子平台由运行时注入 env；自托管/本地运行时必须靠 dotenv 显式加载）
//
// ⚠️ 不能只用 `import 'dotenv/config'`：那只会按 **process.cwd()** 找 .env。
// 部署到托管环境（WorkBuddy 等）时 cwd 未必是 server 目录，会静默读不到配置 →
// STORAGE_DRIVER 回退 local、图片 URL 变成 127.0.0.1，处理链路随后 404。
// 故这里按「本文件所在目录」显式定位一次再兜底 cwd。
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

{
  const candidates = [
    path.resolve(__dirname, '..', '.env'), // dist/main.js → server/.env
    path.resolve(__dirname, '..', '..', '.env'), // 再上一层（部署包结构差异）
    path.resolve(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      break;
    }
  }
  // 全部不存在时仍走一次默认行为，保持与本地开发一致
  dotenv.config();
  // 敏感密钥：decrypt-env.mjs（容器 startCmd 里先跑）把 .env.secrets.enc
  // 还原为 .env.secrets；本地开发则直接就是明文 .env.secrets。
  // dotenv 默认不覆盖已存在的 process.env，故 .env 的非敏感项优先、
  // 敏感项由 .env.secrets 补入，两者键集不重，无冲突。
  for (const p of [
    path.resolve(__dirname, '..', '.env.secrets'), // dist/main.js → server/.env.secrets
    path.resolve(__dirname, '..', '..', '.env.secrets'),
    path.resolve(process.cwd(), '.env.secrets'),
  ]) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      break;
    }
  }
}

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { AppController } from '@/app.controller';
import * as express from 'express';
import { HttpStatusInterceptor } from '@/interceptors/http-status.interceptor';
import { AllExceptionsFilter } from '@/filters/all-exceptions.filter';
import { accessLog, installLogTee } from '@/shared/logger';

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
  // 0. 接管 console.* → 同时落盘 server/logs/app-YYYY-MM-DD.log（保留 7 天）
  //    必须早于 NestFactory.create：否则模块初始化阶段的日志抓不到。
  installLogTee();
  const app = await NestFactory.create(AppModule);

  // 0.5 API 版本前缀：`/api/v2/xxx` → `/api/xxx`（OPS-18 R-工程-06）
  //
  // 为什么用「重写」而不是重挂 70 个处理器：换前缀若靠改 controller 路径，
  // 等于把「版本」硬编码进每个文件，下次 v3 还得再改一遍；重写只在一处，
  // 且**旧 `/api` 继续可用**（向后兼容，老版本小程序不会当场炸）。
  // 响应头 `X-Api-Version` 让调用方知道自己命中的是哪个入口。
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const url = req.url || '';
    if (url.startsWith('/api/v2/') || url === '/api/v2') {
      const rest = url.slice('/api/v2'.length);
      const rewritten = `/api${rest}`;
      req.url = rewritten;
      // originalUrl 也要改：下游（user-context 的引导路由判断、访问日志）读的是它
      (req as unknown as { originalUrl: string }).originalUrl = rewritten;
      res.setHeader('X-Api-Version', 'v2');
    } else if (url.startsWith('/api/')) {
      res.setHeader('X-Api-Version', 'v1');
    }
    next();
  });

  // 0.6 访问日志：每请求一行（方法/路径/状态/耗时/用户/traceId）
  app.use(accessLog);

  // CORS 来源白名单：小程序端请求不带 Origin 头，同源策略对它无效；
  // 真正受约束的是 **H5 扫码登录页**（浏览器环境）。生产环境应在
  // `CORS_ORIGINS` 里只放行该 H5 域名（逗号分隔），未配置时保持放开
  // （本地开发与首次部署的默认行为不变，避免一改就断）。
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
    // 允许前端读取身份回传头（跨域场景下非简单响应头必须显式暴露）：
    //  - X-User-Id：匿名建号回传（小程序不受同源策略限制，本来就能读到）
    //  - X-Auth-Token：每次响应滑动续签的令牌。⚠️ 曾漏配，导致 H5 扫码登录页
    //    （浏览器环境，受 CORS 约束）读不到新令牌 ⇒ 令牌 30 天后过期且无法续期。
    exposedHeaders: ['X-User-Id', 'X-Auth-Token'],
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
