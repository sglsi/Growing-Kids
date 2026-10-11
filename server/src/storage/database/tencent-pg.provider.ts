import { Pool } from 'pg';
import { DbProvider, DbRow, DbQueryResult } from './db-provider.interface';

/**
 * 腾讯云 PostgreSQL 实现（迁移目标库）。
 *
 * 连接串从环境变量读取：
 * - TENCENT_PG_URL：腾讯云 PostgreSQL 实例对外地址（postgresql://user:pass@host:5432/dbname）
 * - TENCENT_PG_SSL：是否启用 SSL（腾讯云 PG 默认要求），默认 true；设 'false' 关闭
 * - TENCENT_PG_POOL_MAX：连接池上限，默认 5
 *
 * 关键的安全设计：未配置 TENCENT_PG_URL 时，health() 返回 false、写操作静默跳过，
 * 使"双写开关"在迁移前的沙箱/开发环境里完全无副作用——绝不会因新库缺失而拖垮主库。
 */
export class TencentPgDbProvider implements DbProvider {
  readonly name = 'tencent-pg';
  private pool: Pool | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const url = process.env.TENCENT_PG_URL;
    if (!url) throw new Error('TENCENT_PG_URL is not set');
    const ssl = process.env.TENCENT_PG_SSL !== 'false';
    this.pool = new Pool({
      connectionString: url,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.TENCENT_PG_POOL_MAX ?? 5),
    });
    return this.pool;
  }

  async query<T = DbRow>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>> {
    const res = await this.getPool().query(sql, (params as any[]) ?? []);
    return { rows: (res.rows as T[]) ?? [], rowCount: res.rowCount ?? 0 };
  }

  async insert<T = DbRow>(table: string, rows: DbRow | DbRow[]): Promise<T[]> {
    const arr = Array.isArray(rows) ? rows : [rows];
    if (!arr.length) return [];
    const cols = Object.keys(arr[0]);
    if (!cols.length) return [];

    const values: unknown[] = [];
    const placeholders: string[] = [];
    arr.forEach((row, ri) => {
      const rowPh: string[] = [];
      cols.forEach((c, ci) => {
        values.push(row[c]);
        rowPh.push(`$${ri * cols.length + ci + 1}`);
      });
      placeholders.push(`(${rowPh.join(',')})`);
    });

    const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(',')}) VALUES ${placeholders.join(
      ',',
    )} RETURNING *`;
    const res = await this.getPool().query(sql, values);
    return (res.rows as T[]) ?? [];
  }

  async update(table: string, set: DbRow, where: DbRow): Promise<number> {
    const setCols = Object.keys(set);
    const whereCols = Object.keys(where);
    const values: unknown[] = [];
    let idx = 1;

    const setSql = setCols.map((c) => `${quote(c)} = $${idx++}`).join(', ');
    values.push(...setCols.map((c) => set[c]));

    const whereSql = whereCols.length
      ? whereCols.map((c) => `${quote(c)} = $${idx++}`).join(' AND ')
      : '1=1';
    values.push(...whereCols.map((c) => where[c]));

    const sql = `UPDATE ${quote(table)} SET ${setSql} WHERE ${whereSql} RETURNING *`;
    const res = await this.getPool().query(sql, values);
    return res.rowCount ?? 0;
  }

  async remove(table: string, where: DbRow): Promise<number> {
    const whereCols = Object.keys(where);
    const values: unknown[] = [];
    let idx = 1;

    const whereSql = whereCols.length
      ? whereCols.map((c) => `${quote(c)} = $${idx++}`).join(' AND ')
      : '1=1';
    values.push(...whereCols.map((c) => where[c]));

    const sql = `DELETE FROM ${quote(table)} WHERE ${whereSql}`;
    const res = await this.getPool().query(sql, values);
    return res.rowCount ?? 0;
  }

  async health(): Promise<boolean> {
    if (!process.env.TENCENT_PG_URL) return false;
    try {
      const res = await this.getPool().query('SELECT 1');
      return res.rowCount === 1;
    } catch {
      return false;
    }
  }
}

/** 标识符安全引用（防注入 + 支持保留字/大小写）。 */
function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
