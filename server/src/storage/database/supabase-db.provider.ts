import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabase-client';
import { DbProvider, DbRow, DbQueryResult } from './db-provider.interface';

/**
 * 用现有 Supabase 客户端实现 DbProvider。
 *
 * - insert / update / remove 走 postgREST builder（与现有 28 处调用语义一致）；
 * - query 走 `rpc('exec_sql')` 占位：需在 Supabase 侧建一个仅 service_role 可调、
 *   内部用 `execute` 跑 SQL 的安全函数，否则抛清晰错误（提示改用 raw() builder）；
 * - raw() 返回底层 SupabaseClient，供 builder 风格的老代码兜底。
 *
 * 迁移完成、主库切到腾讯云 PG 后，此类可整体下线。
 */
export class SupabaseDbProvider implements DbProvider {
  readonly name = 'supabase';
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getSupabaseClient();
  }

  raw(): SupabaseClient {
    return this.client;
  }

  async query<T = DbRow>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>> {
    // Supabase 不走裸 SQL，需服务端 exec_sql RPC；未创建时给出明确指引。
    const { data, error } = await this.client.rpc('exec_sql' as any, {
      sql,
      params: params ?? [],
    } as any);
    if (error) {
      throw new Error(
        `supabase query via exec_sql failed: ${error.message}（若未创建 exec_sql RPC，请改用 raw() builder）`,
      );
    }
    return { rows: (data as T[]) ?? [], rowCount: Array.isArray(data) ? data.length : 0 };
  }

  async insert<T = DbRow>(table: string, rows: DbRow | DbRow[]): Promise<T[]> {
    const { data, error } = await this.client.from(table).insert(rows as any).select();
    if (error) throw new Error(error.message);
    return (data as T[]) ?? [];
  }

  async update(table: string, set: DbRow, where: DbRow): Promise<number> {
    let q = this.client.from(table).update(set as any);
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q.select();
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.length : 0;
  }

  async remove(table: string, where: DbRow): Promise<number> {
    let q = this.client.from(table).delete();
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q.select();
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.length : 0;
  }

  // 主库，视为健康；真要探活可用 raw().from('...').select('1')。
  async health(): Promise<boolean> {
    return true;
  }
}
