/**
 * 数据库抽象层（迁移用）。
 *
 * 设计目标：让业务最终只依赖此接口，从而可在 Supabase / 腾讯云 PostgreSQL 之间无缝切换，
 * 把"换平台"从"重写数据访问层"降维成"换一个 Provider 实现"。
 *
 * 当前阶段（迁移期，Coze→腾讯云）：
 * - 主库仍为 Supabase，现有 28 处 `getSupabaseClient()` 调用保持不变（零回归风险）；
 * - 本接口 + 双写开关用于"灰度/镜像写"到新库，实现零停机迁移；
 * - 待迁移窗口开启、调用点逐步改走 `getDbProvider()` 后，可整切到腾讯云 PG。
 */

export type DbRow = Record<string, any>

export interface DbQueryResult<T = DbRow> {
  rows: T[]
  rowCount: number
}

export interface DbProvider {
  /** 实现名，便于日志与工厂选择。 */
  readonly name: string

  /** 任意 SQL。腾讯云 PG 原生支持；Supabase 侧走 rpc('exec_sql') 占位（见各实现注释）。 */
  query<T = DbRow>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>

  /** 插入一行或多行，返回插入后的行。 */
  insert<T = DbRow>(table: string, rows: DbRow | DbRow[]): Promise<T[]>

  /** 按 where 条件更新 set 字段，返回受影响行数。 */
  update(table: string, set: DbRow, where: DbRow): Promise<number>

  /** 按 where 条件删除，返回受影响行数。 */
  remove(table: string, where: DbRow): Promise<number>

  /** 连通性探活。 */
  health(): Promise<boolean>

  /** 可选：暴露底层原生客户端，供 builder 风格的老代码兜底（仅 Supabase 实现提供）。 */
  raw?(): unknown
}
