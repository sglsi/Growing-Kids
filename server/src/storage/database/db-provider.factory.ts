import { DbProvider } from './db-provider.interface';
import { SupabaseDbProvider } from './supabase-db.provider';
import { TencentPgDbProvider } from './tencent-pg.provider';

/**
 * 数据库 Provider 工厂 + 模式切换。
 *
 * 环境变量 DB_PROVIDER 控制：
 * - supabase   （默认）主库 = Supabase，行为完全不变（现有 28 处调用零改动）
 * - tencent-pg       主库 = 腾讯云 PostgreSQL（为未来整切预留；需逐步把调用点改走 getDbProvider()）
 * - dual            主库 = Supabase，并开启"双写"把写操作镜像到腾讯云 PG（迁移期用）
 */
export type DbProviderMode = 'supabase' | 'tencent-pg' | 'dual';

let primary: DbProvider | null = null;
let secondary: DbProvider | null = null;

export function getDbProviderMode(): DbProviderMode {
  const m = (process.env.DB_PROVIDER || 'supabase') as DbProviderMode;
  return m === 'tencent-pg' || m === 'dual' ? m : 'supabase';
}

/** 主库（业务读写入口）。默认 supabase；dual 模式主库仍是 supabase。 */
export function getDbProvider(): DbProvider {
  if (primary) return primary;
  primary = getDbProviderMode() === 'tencent-pg' ? new TencentPgDbProvider() : new SupabaseDbProvider();
  return primary;
}

/**
 * 双写模式下的"次库"（镜像目标）。
 * 仅 DB_PROVIDER=dual 且已配置 TENCENT_PG_URL 时返回，否则返回 null（主库不受影响）。
 */
export function getSecondaryProvider(): DbProvider | null {
  if (getDbProviderMode() !== 'dual') return null;
  if (!process.env.TENCENT_PG_URL) {
    console.warn(
      '[db-provider] dual 模式已开启但 TENCENT_PG_URL 未配置，次库镜像被禁用（主库不受影响）',
    );
    return null;
  }
  if (!secondary) secondary = new TencentPgDbProvider();
  return secondary;
}
