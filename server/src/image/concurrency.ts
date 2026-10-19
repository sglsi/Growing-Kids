/**
 * ⑨ 有限并发调度器（技术文档 §2.7 ⑨）
 *
 * 主链路 `extractWrong` 此前对 N 个错题块串行执行
 * 「裁图 → ingest 落库 → 取公开 URL → 本地 OCR → 语义分离」，
 * N 块 = N 次顺序 IO 往返，主链路被拉慢。⑨ 改为**块间有限并发**：
 *   - 块内链路保持顺序（OCR 依赖落库后的公开 URL），依赖关系不变；
 *   - 块间以最多 `limit` 个 worker 并发推进，提速主链路又不打爆本地 OCR 侧车。
 *
 * 该实现为零依赖纯函数，可被编译产物独立验证（见部署期验证脚本）：
 *   - 并发上限确实被遵守（同一时刻在跑的 worker 不超过 `limit`）；
 *   - 全部结果按**原顺序**收集返回，与串行语义一致，便于后续层级合并/查重；
 *   - 不内建异常吞没——单块容错由调用方 `worker` 闭包自行 try/catch 负责
 *     （对应原 `for` 循环里「块失败仅 warn + 跳过」的语义），调度器保持纯粹。
 *
 * @param items    待处理元素列表
 * @param worker   处理单个元素的异步函数，返回该元素的结果
 * @param limit    最大并发 worker 数（<=0 或无效值回退为 1）
 * @returns        与 `items` 等长的数组，第 i 位为 `worker(items[i])` 的结果
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.floor(limit) || 1)
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function run(): Promise<void> {
    // 每个 worker 从游标取下一个未处理索引，处理完再取，直到列表耗尽
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await worker(items[i], i)
    }
  }

  const runnerCount = Math.min(effectiveLimit, items.length)
  const runners = Array.from({ length: runnerCount }, () => run())
  await Promise.all(runners)
  return results
}
