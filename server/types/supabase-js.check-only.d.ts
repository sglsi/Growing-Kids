// 类型检查用的本地桩（真实运行时由 @supabase/supabase-js 提供）
// 只覆盖项目里实际用到的链式查询 API 形状。
declare module '@supabase/supabase-js' {
  export interface PostgrestError {
    message: string
    details?: string
    hint?: string
    code?: string
  }

  // 真实 SDK 的 data 形状随 .single()/.maybeSingle() 变化，这里统一放宽为任意值，
  // 避免本地桩把业务代码里合法的 data.length / data[0] 报成错误。
  interface QueryResult<T> {
    data: T
    error: PostgrestError | null
    count?: number | null
  }

  export interface QueryBuilder<T = unknown> extends PromiseLike<QueryResult<any>> {
    select(columns?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): QueryBuilder<T>
    insert(values: unknown, opts?: unknown): QueryBuilder<T>
    update(values: unknown, opts?: unknown): QueryBuilder<T>
    upsert(values: unknown, opts?: unknown): QueryBuilder<T>
    delete(opts?: unknown): QueryBuilder<T>
    eq(column: string, value: unknown): QueryBuilder<T>
    neq(column: string, value: unknown): QueryBuilder<T>
    gt(column: string, value: unknown): QueryBuilder<T>
    gte(column: string, value: unknown): QueryBuilder<T>
    lt(column: string, value: unknown): QueryBuilder<T>
    lte(column: string, value: unknown): QueryBuilder<T>
    like(column: string, pattern: string): QueryBuilder<T>
    ilike(column: string, pattern: string): QueryBuilder<T>
    in(column: string, values: unknown[]): QueryBuilder<T>
    is(column: string, value: unknown): QueryBuilder<T>
    contains(column: string, value: unknown): QueryBuilder<T>
    containedBy(column: string, value: unknown): QueryBuilder<T>
    overlaps(column: string, value: unknown): QueryBuilder<T>
    textSearch(column: string, query: string, opts?: unknown): QueryBuilder<T>
    // PostgREST 逻辑组合：.or('a.eq.1,b.eq.2')
    or(filters: string): QueryBuilder<T>
    not(column: string, operator: string, value: unknown): QueryBuilder<T>
    match(query: Record<string, unknown>): QueryBuilder<T>
    filter(column: string, operator: string, value: unknown): QueryBuilder<T>
    order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string }): QueryBuilder<T>
    limit(count: number): QueryBuilder<T>
    range(from: number, to: number): QueryBuilder<T>
    single(): Promise<QueryResult<T>>
    maybeSingle(): Promise<QueryResult<T>>
    then<TR1 = QueryResult<any>, TR2 = never>(
      onfulfilled?: ((value: QueryResult<any>) => TR1 | PromiseLike<TR1>) | null,
      onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null,
    ): PromiseLike<TR1 | TR2>
  }

  export interface SupabaseClient {
    from<T = unknown>(table: string): QueryBuilder<T>
    rpc(fn: string, args?: Record<string, unknown>): QueryBuilder<unknown>
    auth: unknown
    storage: unknown
  }

  export interface SupabaseClientOptions {
    auth?: unknown
    global?: { headers?: Record<string, string>; fetch?: unknown }
    db?: unknown
  }

  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: SupabaseClientOptions,
  ): SupabaseClient
}
