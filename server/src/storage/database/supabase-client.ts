import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { installSupabaseDnsPin, forceRefreshRankedIps } from './supabase-dns-pin';

let envLoaded = false;

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

/**
 * 加载 .env（仅一次）。
 *
 * 已去除扣子时代的两条平台专属通路：
 *   - `coze_workload_identity`（python Client 拉取平台注入的环境变量）—— 平台外不可用；
 *   - `coze-coding-dev-sdk` 的 getReportBuffer / createWrappedFetch —— 平台内埋点，无必要。
 * 现在凭证一律来自 server/.env，命名已去 COZE_ 前缀（旧名 COZE_SUPABASE_* 仍兼容读取）。
 */
function loadEnv(): void {
  if (envLoaded) return;

  try {
    require('dotenv').config();
  } catch {
    // dotenv not available
  }

  envLoaded = true;
}

/** 兼容读取：优先新名，回退旧名（COZE_ 前缀） */
function envAny(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function getSupabaseCredentials(): SupabaseCredentials {
  loadEnv();

  // 安装 DNS IP 池兜底（幂等）——GFW 间歇封锁官方 Cloudflare IP 时
  // 自动改试备用 anycast IP，详见 supabase-dns-pin.ts 文件头注释。
  installSupabaseDnsPin();

  const url = envAny('SUPABASE_URL', 'COZE_SUPABASE_URL');
  const anonKey = envAny('SUPABASE_ANON_KEY', 'COZE_SUPABASE_ANON_KEY');

  if (!url) {
    throw new Error('SUPABASE_URL is not set（旧名 COZE_SUPABASE_URL 亦可）');
  }
  if (!anonKey) {
    throw new Error('SUPABASE_ANON_KEY is not set（旧名 COZE_SUPABASE_ANON_KEY 亦可）');
  }

  return { url, anonKey };
}

function getSupabaseServiceRoleKey(): string | undefined {
  loadEnv();
  return envAny('SUPABASE_SERVICE_ROLE_KEY', 'COZE_SUPABASE_SERVICE_ROLE_KEY');
}

function getSupabaseClient(token?: string): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();

  let key: string;
  if (token) {
    key = anonKey;
  } else {
    const serviceRoleKey = getSupabaseServiceRoleKey();
    key = serviceRoleKey ?? anonKey;
  }

  return createClient(url, key, {
    ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    // 网络韧性（2026-10-22）：GFW 间歇封锁 Cloudflare/AWS-SG 时，GET 类请求
    // （含中间件 findById——它一挂全部接口 500「用户上下文缺失」）连接失败后
    // 立即强制重探一轮 IP 排名；只有「排名确实变了」才重试，避免封锁持续时
    // 每个请求都白等两倍超时。仅 GET 重试（幂等），写操作不重试防重复写入。
    global: {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        return fetch(input as any, init).catch(async (err) => {
          if (method !== 'GET' && method !== 'HEAD') throw err;
          const changed = await forceRefreshRankedIps();
          if (!changed) throw err;
          return fetch(input as any, init);
        });
      },
    },
    db: {
      timeout: 60000,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { loadEnv, getSupabaseCredentials, getSupabaseServiceRoleKey, getSupabaseClient };
