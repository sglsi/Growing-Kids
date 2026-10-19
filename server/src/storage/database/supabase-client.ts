import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
