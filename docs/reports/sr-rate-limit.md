# 智能高清（SR）服务端限流 / 排队

> 承接《自动调正与智能高清重构方案》Phase 2（智能高清）。
> 依据 **1 核虚拟主机压测实测结论**，给 x3 / x4 / ESPCN 等重任务加上服务端保护，防止 CPU 雪崩拖垮整个服务。

---

## 一、为什么必须做（压测实测驱动，非拍脑袋）

| 倍率 | 模式 | p50 单图 | 4 路并发端到端 |
|---|---|---|---|
| x2 | classical | 1019 ms | 4162 ms |
| x2 | espcn | 3322 ms | 13186 ms |
| x3 | classical | 2277 ms | 9141 ms |
| x3 | espcn | 5434 ms | **21898 ms** |

测试环境：单核虚拟主机，输入 1600×1200。

**根因（两条都成立）**：

1. `superResolveESPCN` 是**纯 JS 嵌套循环 → 同步阻塞 Node 事件循环**。它在跑的期间，Node 连「另一个请求的响应」都发不出去。
2. classical 路径走 sharp/libvips，虽然是异步的，但同样**把 CPU 吃满**，与 ESPCN 争抢同一个核心。

⇒ **光「限频」不够**：限频只能限制「单位时间发起数」，挡不住「同时 4 个已经进来的重任务一起把机器压死」。**必须限制同时在跑的重任务数 —— 即并发闸。**

---

## 二、两道防线（用户确认「两者都做」）

| 防线 | 类 | 目标 | 保护对象 |
|---|---|---|---|
| ① 全局并发闸 | `SrGate` | 限制同时运行的重任务（含权重） | **小主机**：防 CPU 雪崩 |
| ② 用户级配额 | `SrUserQuota` | 限制单用户频率 + 并发 | **全体用户**：防单人滥用拖垮服务 |

---

## 三、任务分级（用户确认口径）

**`heavy = scale >= 3 || mode === 'espcn'`**；仅 **x2-classical 为 light（宽松，不限流）**。

`cost` 依据实测 p50 延迟比例定档（以 x2-classical ≈ 1.0s 为 1 个单位）：

| 任务 | lane | cost |
|---|---|:--:|
| x2 classical | light | 1 |
| x3 classical | heavy | 2 |
| x4 classical | heavy | 3 |
| x2/x3/x4 espcn | heavy | 3 |

**为什么按权重而非个数**：一个 x4（≈3.4s）≈ 三个 x2（≈1.0s）的 CPU 占用。若按「个数」计，1 核机器上把 x4 和 x2 当同类并行，会瞬间过载。权重计费让并发数真实反映 CPU 压力。

核心纯函数（无依赖，便于单测）：

```ts
export function classifySr(scale: SrScale, mode: SrMode): SrClass {
  const heavy = scale >= 3 || mode === 'espcn'
  if (!heavy) return { heavy: false, lane: 'light', cost: 1 }
  if (mode === 'espcn') return { heavy: true, lane: 'heavy', cost: 3 }
  return { heavy: true, lane: 'heavy', cost: scale === 4 ? 3 : 2 }
}
```

---

## 四、并发闸 `SrGate`（双泳道 + 权重计费 + FIFO）

- **双泳道**：`light`（默认额度 2，按**个数**）、`heavy`（默认额度 1，按**权重和**）。轻任务不被重任务拖累，重任务也不会因轻任务占位而放行。
- **门槛额度自适应（关键修复）**：实际门槛 = `max(配置额度, 该任务 cost)`。**否则会死锁** —— 默认 `IMG_SR_CONCURRENCY_HEAVY=1` 而 x4/espcn 的 cost=3，`0+3<=1` 恒假 ⇒ 所有重任务永远排不进、只能等到超时被误拒。详见 §十一-1。
- **FIFO 公平**：队列非空时一律入队（**不插队**），避免「后来的小任务饿死前面的大任务」。
- **排队超时**：`acquire(cost, lane, {timeoutMs})`，超时返回 `{ok:false, reason:'timeout'}`。
- **队列上限**：队列满 → 立即 `queue_full`，不无限积压（保护内存与连接）。
- **额度归还唤醒**：`release(cost, lane)` 后 `pump()` 唤醒队首（额度够才出队）。

```ts
const acq = await srGate.acquire(cls.cost, cls.lane, { timeoutMs: 20000 })
// → { ok, reason?, waitedMs?, cost? }；成功必须 finally 中 release(cost, lane)
```

---

## 五、用户级配额 `SrUserQuota`（进程内滑动窗口）

- **限次**：每用户每 **60s** 内 heavy 次数上限（默认 6）。
- **限并发**：每用户 heavy 同时进行数（默认 1）。
- **区分错误码**：`SR_USER_BUSY`（已有图在跑，`retryAfterMs≈2s`）vs `SR_RATE_LIMIT`（超每分钟上限，`retryAfterMs` 为窗口剩余）。
- 进程内 `Map`，**无 DB**，重启即重置（可接受）。

---

## 六、超限行为（用户确认：排队超时后降级提示）

**不硬拒、不静默降级**，而是给出可操作的友好提示，引导用户改选轻量档：

| 场景 | HTTP | code | 前端行为 |
|---|:--:|---|---|
| 用户并发超限 | 429 | `SR_USER_BUSY` | toast：「你还有一张高清图正在处理」 |
| 用户频率超限 | 429 | `SR_RATE_LIMIT` | toast：「处理太频繁，请稍后再试」 |
| 排队超时 | 503 | `SR_QUEUE_TIMEOUT` | 弹窗询问是否**用 x2 快速模式**重试一次 |
| 队列满 | 503 | `SR_QUEUE_TIMEOUT`（reason=`queue_full`） | 同上 |

响应体统一带 `data.suggest = { scale: 2, mode: 'classical' }`，前端据此引导降级。

---

## 七、实现落点

### 后端

| 文件 | 改动 |
|---|---|
| `src/image/sr-gate.ts`（**新**） | `classifySr` + `SrGate` + `SrUserQuota` + 单例 + 开关，纯逻辑无 Nest/DB 依赖 |
| `src/image/image.service.ts` | `enhance()` 用闸包裹 `enhanceImage`；失败抛 `HttpException(429/503)`；`finally` 保证 release；`debug` 增 `gate` 字段 |
| `src/image/image.controller.ts` | enhance 分支 catch 增 **限流豁免**：`isRateLimitError`（429/503）直接透传，**不让 hybrid 兜底把重任务推给更贵的图生图** |

关键片段（service）：

```ts
const cls = classifySr(scale, mode)
const useGate = srGateEnabled() && cls.heavy
if (useGate) {
  const q = srUserQuota.check(userId)
  if (!q.ok) throw new HttpException({ code: q.code, /* ... */ }, HttpStatus.TOO_MANY_REQUESTS)
  const acq = await srGate.acquire(cls.cost, cls.lane, { timeoutMs: 20000 })
  if (!acq.ok) throw new HttpException({ code: 'SR_QUEUE_TIMEOUT', /* ... */ }, HttpStatus.SERVICE_UNAVAILABLE)
}
try { result = await enhanceImage(srcBuffer, { scale, mode, weightsUrl }) }
finally { if (acquired) srGate.release(cls.cost, cls.lane); if (quotaHeld) srUserQuota.releaseUser(userId) }
```

### 前端

| 文件 | 改动 |
|---|---|
| `src/services/api.ts` | 新增 `ApiError extends Error`（带 `status`/`code`/`data`）；`unwrap` 非 2xx 抛 `ApiError`（保留 body 的 code/data） |
| `src/components/image-editor.tsx` | 新增 `handleSrRateLimit`：429 → toast；503 → 弹窗询问降级 x2 → 改档后**仅重试一次**（`degradedRetry` 标志防循环）；重构收尾为统一 `setAiBusy(false); Taro.hideLoading()`，两处早返回显式清理避免 loading 交叉 |

**为什么重试要「先 setAiBusy(false)」**：`handleAi` 开头有 `if (aiBusy) return` 守卫，而降级重试发生在同一次调用内部、`aiBusy` 仍为 true —— 必须先复位再重入。

---

## 八、配置（环境变量）

| 变量 | 默认 | 含义 |
|---|:--:|---|
| `IMG_SR_GATE` | `on` | `off` = 一键回退旧行为（不设闸、不设配额） |
| `IMG_SR_CONCURRENCY_LIGHT` | `2` | light 泳道并发**个数** |
| `IMG_SR_CONCURRENCY_HEAVY` | `1` | heavy 泳道并发**权重和**（1 核跑满即 1） |
| `IMG_SR_QUEUE_MAX` | `8` | 排队上限（超出即 `queue_full`） |
| `IMG_SR_QUEUE_TIMEOUT_MS` | `20000` | 排队等待上限 |
| `IMG_SR_USER_RATE` | `6` | 每用户每 60s heavy 次数上限 |
| `IMG_SR_USER_CONCURRENT` | `1` | 每用户 heavy 同时进行数 |

> **1 核小主机推荐值即默认值**；多核可线性放大 `IMG_SR_CONCURRENCY_HEAVY`。

---

## 九、测试

新增 `dynamic-tests/run-image-v6.ts`（**61 项断言**，import 真实模块）：

| 组 | 覆盖 |
|---|---|
| ① classifySr 分级 | x2-classical→light/1；x3-classical→heavy/2；x4-classical→cost3；x2/x4-espcn→heavy/3 |
| ② SrGate | 首个立即通过、第二个排队、release 唤醒队首、权重计费、light/heavy 泳道独立、排队超时 `waited=61ms`、队列满 `queue_full`、归零不泄漏、`rejected` 统计、**cost>limit 不死锁** |
| ③ SrUserQuota | 首次通过、并发 2 次→`SR_USER_BUSY`、release 后放行、用户隔离、超上限→`SR_RATE_LIMIT`（`retryAfterMs=60000`）、`sweep` 不抛 |
| ④ 源码一致性 | service / controller / gate / editor / api 全部关键模式 |
| ⑤ env 清单 | 7 个变量齐全、`srGateEnabled` 默认 on |

**全量回归**：

| 套件 | 结果 |
|---|:--:|
| v2（Phase 1） | ✅ 18/18 |
| v3（Phase 2） | ✅ 24/24 |
| v4（Phase 3） | ✅ 37/37 |
| v5（四角 UI） | ✅ 26/26 |
| **v6（限流，新）** | ✅ **61/61** |
| 后端 `tsc --noEmit` / `nest build` | ✅ 0 错 / 通过 |
| 前端 `tsc --noEmit`（harness，真实解析 editor+api） | ✅ 0 错 |

**真实集成验证**（import 真实单例，模拟 service 闸包裹跑并发重任务）：并发 4 个 x4-classical（cost=3），额度=1、超时 300ms →
`job#1 ACQUIRED waited=0ms`（501ms 完成），其余 3 个 `REJECTED reason=timeout`（友好降级）。符合「1 核下同时只跑 1 个重任务，其余降级」的设计意图。

合计 **166 项动态断言全绿**。

---

## 十、诚实局限

1. **闸是进程内的**：PM2 cluster / 多副本下各进程**独立计数** ⇒ 实际全局并发 = 额度 × 进程数。生产多副本需改 **Redis 信号量**（本期不做）。
2. **排队占着 HTTP 连接**（默认最多 20s）：小并发可接受，高并发下会占用连接池，需与网关超时联动。
3. **并发闸限制「同时数」，不消除单次同步阻塞**：ESPCN 的单次调用仍会阻塞事件循环（只是不会再叠加）。彻底解法是 **worker_threads 隔离**，列为后续项。
4. **配额重启即重置**：进程内 Map，多实例/重启后计数归零；对「防误用」足够，对「计费级配额」不够。
5. **降级重试仅一次**：严格用 `degradedRetry` 标志限定，防止 429/503 循环重试放大负载。

---

## 十一、实施中发现并修复的缺陷

### 1. 权重额度死锁（生产级致命，集成验证才发现）

**现象**：真实默认 `IMG_SR_CONCURRENCY_HEAVY=1`，而 x3/x4/espcn 的 `cost=2/3`。原 `canRunNow` 用 `runningHeavyCost + cost <= heavyLimit` 判断 → `0+3 <= 1` **恒为假** ⇒ **所有重任务都永远排不进闸**，只能干等到 20s 超时被拒。等于「限流把功能限死」——比不做限流更糟。

**为什么单测没抓到**：v6 原测试要么只测 `cost=1`，要么测 `cost=3` 时把额度设成 3，**恰好绕过了 `cost > limit` 这个真实组合**。

**修复**：门槛额度取 `max(配置额度, 该任务 cost)` —— 「宁可放一个最重的进来跑，也不要全饿死」：
```ts
private canRunNow(lane: SrLane, cost: number): boolean {
  if (lane === 'light') return this.runningLight + 1 <= this.lightLimit
  const effective = Math.max(this.heavyLimit, cost)
  return this.runningHeavyCost + cost <= effective
}
```
**回归护栏**：v6 新增 4 项断言（`cost>limit` 首个必进、占满后排队、释放后进入、归零），锁死此场景不再复现。

### 2. 限流错误被 hybrid 兜底吞掉（实现时已预防）

enhance 分支的 catch 会把未知错误降级为「图生图」兜底。若 429/503 限流错误被吞，会**绕过保护、把重任务推给更贵的下游**。已在 controller 加 `isRateLimitError`（429/503 直接透传）。

### 3. 降级重试被 `aiBusy` 守卫拦截（实现时已修）

`handleAi` 开头 `if (aiBusy) return`，而降级重试在同一次调用内部、`aiBusy` 仍为 true → 重试被拦。已在重试前 `setAiBusy(false)`。

---

## 十二、变更文件清单

**后端**
- `server/src/image/sr-gate.ts`（新；含 `canRunNow` 死锁修复）
- `server/src/image/image.service.ts`
- `server/src/image/image.controller.ts`

**前端**
- `src/services/api.ts`
- `src/components/image-editor.tsx`

**测试 / 文档**
- `dynamic-tests/run-image-v6.ts`（新，61 项）
- `docs/sr-rate-limit.md`（新）
