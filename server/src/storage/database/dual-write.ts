import { DbProvider, DbRow } from './db-provider.interface';
import { getSecondaryProvider } from './db-provider.factory';

/**
 * 双写开关与镜像写工具（迁移期核心）。
 *
 * 设计原则（缺一不可）：
 * 1. 仅 DB_PROVIDER=dual 时生效，其余模式直接 return，零开销；
 * 2. 次库失败只告警、绝不抛错 —— 保证主库权威、迁移零风险；
 * 3. secondary 可注入，便于纯函数单测（无需真实数据库）。
 *
 * 用法：在现有写路径「主库写入成功后」追加一行，例如
 *   const { data, error } = await client.from(TABLE).insert(payload).select().single()
 *   if (error) throw new Error(error.message)
 *   await mirrorInsert(TABLE, payload)   // ← 新增这一行
 */

/** 双写总开关。 */
export function isDualWriteEnabled(): boolean {
  return process.env.DB_PROVIDER === 'dual';
}

export async function mirrorInsert(
  table: string,
  rows: DbRow | DbRow[],
  secondary?: DbProvider | null,
): Promise<void> {
  if (!isDualWriteEnabled()) return;
  const sec = secondary ?? getSecondaryProvider();
  if (!sec) return;
  try {
    await sec.insert(table, rows);
  } catch (e) {
    console.warn(`[dual-write] mirrorInsert → ${sec.name} 失败(${table}):`, (e as Error)?.message ?? e);
  }
}

export async function mirrorUpdate(
  table: string,
  set: DbRow,
  where: DbRow,
  secondary?: DbProvider | null,
): Promise<void> {
  if (!isDualWriteEnabled()) return;
  const sec = secondary ?? getSecondaryProvider();
  if (!sec) return;
  try {
    await sec.update(table, set, where);
  } catch (e) {
    console.warn(`[dual-write] mirrorUpdate → ${sec.name} 失败(${table}):`, (e as Error)?.message ?? e);
  }
}

export async function mirrorDelete(
  table: string,
  where: DbRow,
  secondary?: DbProvider | null,
): Promise<void> {
  if (!isDualWriteEnabled()) return;
  const sec = secondary ?? getSecondaryProvider();
  if (!sec) return;
  try {
    await sec.remove(table, where);
  } catch (e) {
    console.warn(`[dual-write] mirrorDelete → ${sec.name} 失败(${table}):`, (e as Error)?.message ?? e);
  }
}
