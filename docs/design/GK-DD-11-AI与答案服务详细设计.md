# GK-DD-11 AI 与答案服务详细设计

> 编号：GK-DD-11 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：后端 / 产品 ｜ 上游：SRS-01、ADD-04、ADD-06 ｜ 下游：QA-16、OPS-18
> 定位：三模式搜题与 LLM 降级链的完整说明。🔴 **"三个按钮不许互相冒充"是产品红线**。
> 边界：外部系统契约见 ADD-04 第 9 章，接口字段见 ADD-06，本文讲策略与算法。

---

## 1. 文档目的与读者

覆盖「**题目答案怎么来**」的全部实现：三模式边界、检索策略、LLM 降级链、缓存与配额、可信性约束。

---

## 2. 能力概述与产品口径（写死，任何实现不得越界）

| 按钮 | `mode` | 做什么 | **不做什么** | 结果标注 |
|---|---|---|---|---|
| 联网搜题 | `search` | 只检索，原样返回找到的内容 | 不喂 AI、不编造 | 附来源链接，`verified = true` |
| 知识库 | `kb` | 只检索 ima 知识库 | 不推理 | 附文档来源（无外链），`verified = true` |
| AI 解题 | `ai` | 只推理 | 不联网核实 | 🔴 **`verified = false`，标注「AI 推理结果，未联网核实，请自行判断」** |

**无结果时如实说明，绝不用其它模式的结果顶替。** 三模式**互不兜底**——任一模式失败只返回 `source='none'` + 引导文案，由用户手动换按钮。

---

## 3. 接口契约

### 3.1 端点

```
POST /api/answer-search/:itemId     @HttpCode(200)
body: { force?: boolean, mode?: 'search' | 'ai' | 'kb' }
```

⚠️ **`mode` 是 body 参数**，写进 query 会静默落到 `search`。归一化：`ai` / `kb` 之外一律 `search`。

🔴 **本接口不写库**——只有前端点「采纳」才写（见 §10.3）。

### 3.2 返回结构（`AnswerSearchResult`）

| 字段 | search | kb | ai |
|---|---|---|---|
| `source` | `'search'` | `'kb'` | `'llm'` |
| `verified` | `true` | `true` | 🔴 **`false`** |
| `refs` | `items.filter(i => i.url).slice(0,5)`，**必须有 url** | `items.slice(0,5)`，`url` 恒为 `''` | 恒 `[]` |
| `confidence` | 相关性即可用性门槛 | 仅展示，无门槛 | 恒 `0` |
| `answer` | top 条目 summary/snippet 截断 500 字 | 同左 | 解析出的 `answer_content` |
| `solution` | 前 3 条 `title：摘要(200字)` 拼接 | 同左 | 解析出的 `solution` |
| `note` | 「来自网络检索（未做 AI 整理），请核对后采纳」 | 「来自 ima 知识库（未做 AI 整理），请核对后采纳」 | 「AI 推理结果，未联网核实，请自行判断」 |

失败时统一 `source = 'none'` + `note`（文案见 §9.3）。

### 3.3 ⚠️ 缓存 key 必须带 mode 前缀

```ts
const qHash = sha256(question).digest('hex').slice(0, 32)   // 取前 32 位
const cacheKey = `${CACHE_PREFIX}${mode}:${qHash}`           // CACHE_PREFIX = 'ans:srch:'
```

**mode 不入 key 会导致三种模式结果串味**（历史事故，ADR-003）。

### 3.4 `force` 的语义与代价

`force=true` **只跳过读缓存**，仍然：① **计入每日配额**；② 仍会**写入**缓存（覆盖旧条目）。

---

## 4. `mode=search`（联网搜题）

| 环节 | 实现 |
|---|---|
| Provider | `resolveSearchProvider()` → `provider.search(question, 8)` |
| 单次超时 | **8s**（常量，无环境变量）；`count` 钳位到 1~10 |
| 扣子联网搜轮询超时 | `ANSWER_SEARCH_COZE_TIMEOUT_MS` = **180000**（单独放宽，不改全局 `COZE_CHAT_TIMEOUT_MS`，避免拖慢普通对话降级） |
| 采用条件 | `items.length > 0 && conf > 0` |
| 解析失败 | `CozeBotSearchProvider` 返回 `[]`——**绝不伪造**（2026-10-21 已移除"让模型编 JSON 冒充搜索结果"的行为） |

⚠️ `SearchClient.advancedSearch` 在非 coze 时**明确抛错**；唯一残留调用方是 legacy `/api/search/solve`（前端已无调用方）。

---

## 5. `mode=kb`（ima 知识库）

> 本模块技术含量最高，改检索策略前必读 §5.3 三条红线。

### 5.1 认证与响应

| 项 | 实现 |
|---|---|
| 端点 | `POST https://ima.qq.com/openapi/wiki/v1/search_knowledge` |
| 鉴权 | **两个自定义头** `ima-openapi-clientid` / `ima-openapi-apikey` + `Content-Type: application/json`（**非 Bearer**） |
| 请求体 | `{ query, cursor: '', knowledge_base_id }` |
| 响应兼容 | `json.code ?? json.retcode`；`msg ?? errmsg`（双口径） |
| 单库超时 | `IMA_SEARCH_TIMEOUT_MS` 默认 **15000** |
| 条目解析 | `title + cleanHighlight(highlight_content)`——⚠️ 必须清洗 `<em>` 与 HTML 实体，否则小程序 `Text` 显示字面标签 |
| 外链 | **无**：`url: ''`，`site_name: 'ima 知识库'` |
| 多库合并 | `interleave()` 按各库相关序**交错** + 标题归一化去重 + 截取 count |

### 5.2 ⚠️ ima 当前真实状态（重要，与旧文档口径不同）

| 判断 | 依据 |
|---|---|
| provider **代码完整可用** | `ima-provider.ts` 392 行，仍在被调用 |
| 🔴 **订阅知识库不能通过 API 检索**：实测 `220030：没有权限通过 skill 获取订阅知识库的文件`，只有**自建库**可用 | ADD-04:280；`2026-10-24.md:453-457` |
| 决策：ima 降级为"可选补充"，后续改**教辅切片自建检索（pgvector）** | ADR-009（ADD-04:346） |
| ⚠️ 代码注释仍写"6 个 K12 订阅库"，未同步上述结论 | `ima-provider.ts:20-21` |
| ⚠️ 无 `220030` 的代码级特判 ⇒ 用户看到的是泛化文案「知识库检索失败（ima 错误 220030…）」 | 全仓 grep 仅文档提及 |

### 5.3 ⚠️ 三条实测红线

1. **全词 AND 语义**：「一元二次方程」24 条，加「解法」后 0 条 ⇒ **自然语句题干必零命中，必须降级**；
2. **日配额 `220021`**：「资料获取次数已达上限」，**按调用计数、零命中也扣、不可退避** ⇒ 触发立即上抛并早停，生成专属提示文案；
3. **QPS 限流 `200001`**（HTTP 403）：可退避，单库间隔 900ms 重试一次、库间 250ms。

### 5.4 先导探针式检索（调用预算治理）

**探针链**（`buildQueryFallbacks`，顺序即优先级）：

```
关键词串 → 前 4 词（>4 词）→ 前 2 词（>2 词）→ tokens[0] 去内部停用词
→ 书名号内容（《出师表》→ 出师表）→ 最长 token 的 4 字窗（步长 1，上限 3）
```

**执行**：① 主库（配置里第一个）逐级探针，命中即返回；② 主库全零/报错 → 取"第一个 ≤8 字无空格单词"作最强主题词，**串行**兜底一轮。

| 环境变量 | 默认值 |
|---|---|
| `IMA_PROBE_MAX`（主库探针级数上限） | **2** |
| `IMA_FALLBACK_KB_MAX`（兜底轮最多查几个库） | **2** |
| `IMA_KB_GAP_MS`（兜底轮库间间隔） | 250 |
| `IMA_RETRY_BACKOFF_MS`（200001 退避重试） | 900 |

**调用预算：最坏 2 + 2 = 4 次/题**（历史上是"6 级探针 + 6 库并行"，最坏 54 次 ⇒ 压缩到 4 次）。

⚠️ 提纲旧记"最坏 12 次 / 6 库并行"已被 2026-10-24 压缩取代，以本文为准。

⚠️ `IMA_ROUND_GAP_MS`（600）已定义但**全文件未被使用**——探针循环内部无间隔 sleep，只有兜底轮有库间间隔。

---

## 6. `mode=ai`（AI 解题）

| 环节 | 实现 |
|---|---|
| 入口 | `deduce(question)` → `LLMClient.invoke` |
| 题干来源 | `content.question` → `content.stem` → `title`；为空且是图片题 ⇒ OCR 题面图；再为空且 `kind=image` ⇒ OCR 主图 |
| 输出解析 | JSON 优先 → 【答案】【解析】标签兜底 → 纯文本兜底 |
| `verified` | 🔴 恒 `false`；`refs` 恒 `[]` |
| 失败 | `note` = 「AI 解题失败：请检查模型 Key（COZE_API_TOKEN 扣子 / DEEPSEEK_API_KEY DeepSeek / HUNYUAN_API_TOKEN 混元）后重试」 |

⚠️ 含图消息默认跳过 DeepSeek（除非配 `DEEPSEEK_VISION_MODEL`）。

---

## 7. LLM 供应商与降级链

### 7.1 降级顺序

```
coze（扣子）→ deepseek → hunyuan（混元）
```

- 默认链 `LLM_PROVIDER_CHAIN=coze,deepseek,hunyuan`；`AI_PROVIDER` 默认 `coze`；
- 链过滤：只保留**配了 Key** 的 provider（coze→`COZE_API_TOKEN`，deepseek→`DEEPSEEK_API_KEY`，hunyuan→`HUNYUAN_API_KEY`）；
- 三个 Key 全无 ⇒ **抛错并列出三种获取方式，绝不静默**；
- 遍历链，任一 provider 抛错 ⇒ `console.warn` 后试下一级；**返回空内容也视为失败**继续降级；
- 链全部失败 ⇒ 抛最后一个错误；若 `lastErr` 非 Error 则抛「大模型调用失败（降级链已全部尝试）」。

### 7.2 三个 provider

| Provider | 端点 | 默认模型 | 超时 | 重试 |
|---|---|---|---|---|
| coze | `POST {COZE_CN_BASE_URL}/v3/chat` → `/retrieve` 轮询 → `/message/list`（默认 `https://api.coze.cn`） | — | `COZE_CHAT_TIMEOUT_MS` 120000 | 轮询 1s/次至 completed；无 HTTP 层重试 |
| deepseek | `{DEEPSEEK_BASE_URL}/chat/completions`（默认 `https://api.deepseek.com`） | `deepseek-v4-flash` | `DEEPSEEK_TIMEOUT_MS` 120000 | 429/5xx 退避 **1200ms 重试一次** |
| hunyuan | `{HUNYUAN_BASE_URL}/chat/completions`（默认 `https://api.hunyuan.cloud.tencent.com/v1`） | `hunyuan-turbos-latest`；含图 `hunyuan-vision-latest` | `HUNYUAN_TIMEOUT_MS` 120000 | 同上 |

### 7.3 三条硬约束

1. ⚠️ **扣子必须走标准 OpenAPI 直连**（`api.coze.cn/v3/chat`），SDK 只认平台运行时注入的 JWT，**平台外必失败**；
2. ⚠️ **取回复只认 `type === 'answer'` 的消息**（旧写法按 role 取会拿到 verbose 事件 JSON）；
3. ⚠️ **小程序绝不前端直连第三方 LLM**，一律后端代理（包内无 Key）。

其它：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 弃用；`ImageGenerationClient.generate()` 直接抛错（混元开放接口不支持图生图）。

---

## 8. 通用对话端点

| 端点 | 权限 | 特点 |
|---|---|---|
| `POST /api/chat/message`（智能客服） | `requireUserId` | 带小程序人设 + 知识库 RAG；**落库**；过内容安全检测 |
| `GET /api/chat/messages?session_id=` | `requireUserId` | 升序 `.limit(200)` |
| `GET/POST/PATCH/DELETE /api/chat/knowledge[/:id]` | 🔴 **全部 `requireAdmin`** | 全局表，写操作受白名单保护 |
| `POST /api/chat`（通用对话） | `requireUserId` | **中性 LLM**：不带知识库、不落库、**不过内容安全检测** |

⚠️ **`/api/chat` 的前端封装 `src/services/chat.ts` 全仓库无调用方**——"已实现待接入"。

### 8.1 多轮上下文

| 场景 | 实现 | ⚠️ |
|---|---|---|
| 客服 | 写用户消息后，按 `created_at` **升序** `.limit(20)` 取同 session 历史 | 注释写"最近 20 条"，实现是**最早** 20 条 ⇒ 长会话会丢最近上下文。**必须同时 `.eq('session_id').eq('user_id')`**（session_id 客户端可控，否则越权读 + 喂给 LLM） |
| 通用对话 | history 完全由前端 body 传入，后端只过滤 role/content 非空 | **不落库、无条数上限** |

### 8.2 system prompt 构成

`SYSTEM_PROMPT_TEMPLATE(articles)`：身份与风格（称呼"您"、纯文本禁 markdown）→ 回答原则 4 条（限小程序话题，越界用 `OFF_TOPIC_HINT` 引导）→ 【知识库】段落（按 `sort_order` 升序，逐条 `【title】\n content`；空库统一回 `FALLBACK_REPLY`）。

**知识库文章** `getActiveArticles()` 取 `is_active=true` 全量，**进程内缓存 5 分钟**；写/改/删后 `invalidateCache()`。

**兜底话术**：客服 `FALLBACK_REPLY = '这个问题我还在学习中…'`；通用对话 `'抱歉，AI 助手暂时不可用，请稍后再试。'`

---

## 9. 缓存与配额

### 9.1 缓存（两级）

| 层 | 实现 | TTL |
|---|---|---|
| 内存层 | `memGet / memSet`，key `ans:srch:{mode}:{qHash}` | **24h** |
| 持久层 | `answer_cache` 表（0014），按 `user_id + q_hash + mode` | 成功结果**默认永久**（`ANSWER_CACHE_TTL_DAYS=0`）；失败/零命中 **12h**（`ANSWER_CACHE_NEG_TTL_HOURS`） |

- 成功判定：`ok = result.source !== 'none'`；
- 命中计数：best-effort `hit_count + 1`，失败仅 `console.error` 不影响主流程；
- 写入：每次真实调用后无条件写（**含 `source='none'`**），`upsert` 不动 `created_at`；
- ⚠️ **无总开关环境变量**——禁用只能靠 `force=true` 绕过读取；
- ⚠️ 持久层查询**必须显式 `.eq('user_id', userId)`**（RLS 全注释 + service_role）。

> 注：缓存逻辑**内联在 `answer-search.service.ts` 的私有方法里**，不存在独立的 `answer-cache.service.ts`。

### 9.2 配额消耗点

| 配额项 | 限制 | 计数载体 |
|---|---|---|
| 每日搜题次数 | `ANSWER_SEARCH_DAILY_LIMIT` 默认 **20**（非法值回退 20） | mem-cache，key `ans:q:{userId}:{YYYY-MM-DD}`，TTL 24h |
| ima 日调用 | ~500 次/天（按账号档位） | 外部，见 §5.3 |

⚠️ **计数时机在缓存读取之后**：缓存命中**不消耗**配额；`force` 因跳过读缓存**必然消耗**。

⚠️ **计数在进程内存**，重启即清零；跨天靠 key 里的日期自然切换。

⚠️ **超限表现是 HTTP 200 + `source='none'` + note，不是 429**（controller 恒 `@HttpCode(200)`）。

### 9.3 超限 / 失败文案（三种模式各不相同）

| 场景 | 文案 |
|---|---|
| 每日次数用尽 | 「今日搜题次数已用完（{limit} 次/天），明天再试」 |
| 联网检索失败 | 「联网检索失败（{err 前 60 字}），可改试「AI 解题」」 |
| 联网零结果 | 「未在网络上检索到该题的相关资料，可改试「AI 解题」」 |
| ima 配额耗尽 | 「知识库今日调用次数已达上限，请明天再试；可改试「联网搜题」或「AI 解题」」 |
| ima 检索报错 | 「知识库检索失败（{err 前 80 字}），可改试…」 |
| ima 零命中 | 「知识库中未找到该题的相关内容，可改试…」 |
| AI 解题失败 | 「AI 解题失败：请检查模型 Key（…）后重试」 |
| 题干为空 | 「题干为空，请先填写题干或识别题面图后再搜答案」 |

---

## 10. 前端展示规则

### 10.1 来源徽标（三种模式视觉可区分）

| 来源 | 抬头文案 | 配色 |
|---|---|---|
| `search` | 网络检索结果（N 条来源） | 品牌绿（verified） |
| `kb` | 知识库检索结果（N 条） | 品牌绿（verified） |
| `llm` | 🔴 AI 推理结果（未联网核实） | 橙色 `#E8A33D`（unverified） |

### 10.2 refs 展示

`answer_refs: { title: string, url?: string }[]`——**url 可空**（知识库条目无外链）。无链接时降级为纯文本展示，**绝不显示可复制的假链接**。AI 模式 `refs` 恒空 ⇒ 前端不展示来源区。

### 10.3 编辑与采纳流程（核心安全阀）

```
/api/answer-search 返回候选（不写库）
   ↓ 用户在 answer-editor 中查看 / 编辑
   ↓ 点「采纳」
   ↓ 写入 answer_refs + answer_source + answer_searched_at
```

⚠️ **AI 结果必须用户显式点「采纳」才入库**——这是防止 AI 内容污染题库的核心闸门。

⚠️ **已知口径缺陷**：采纳时 `source==='kb'` 被记为 `answer_source: 'search'`（`answer-editor.tsx:281`）⇒ 知识库来源在库里**不可区分**；而 LLM 结果被记为 `'mixed'`，但 `AnswerSource` 枚举只有 `manual | search | ocr`——`'mixed'` 并不存在于后端枚举中。登记 OPS-18。

---

## 11. 可信性约束与内容安全

### 11.1 可信性

- `verified` 闸门：`source === 'llm'` ⇒ `verified = false`；
- 检索类结果带「未做 AI 整理，请核对后采纳」——**不冒充官方答案**；
- 客服 system prompt 强制"不确定就说还在学习"。

### 11.2 内容安全（`security.msgSecCheck` v2）

| 项 | 实现 |
|---|---|
| 接口 | `wxa/msg_sec_check`，token 由 `cgi-bin/token` 获取（官方 2h，本地提前 5 分钟过期） |
| 请求体 | `{ content, scene, version: 2, openid }`，`scene` 默认 2 |
| ⚠️ **实际接入点仅 2 处** | ① `chat.sendMessage` 用户提问入库前；② 知识库文章写库前 |
| ⚠️ **以下未过检** | `POST /api/chat` 通用对话、**AI 回复**、`answer-search`（题干/答案）、timeline 题干与答案保存、OCR 提取结果 |
| 🔴 **openid 必填** | v2 强制要 openid，否则 `40003 invalid openid` ⇒ 检测形同虚设。本项目 userId 是内部 UUID，需换 `users.open_id`（Map 缓存 5 分钟） |
| 匿名（`open_id` 为 NULL） | 跳过检测，`suggest: 'skipped'`，仅告警一次 |
| 超长切片 | 按**字符数** 2000 切片逐段检测（微信上限 2500 留余量；`splitByChars` 避免多字节切坏） |
| `87014` | **拒绝**（`allowed: false`，`suggest: 'reject'`）⇒ `BadRequestException` ⇒ HTTP 400 |

**失败放行策略（best-effort）**：未配 appid/secret → 放行；匿名无 openid → 放行；`40001` token 失效 → 清缓存、本次放行；其他 errcode（如 45009 限频）→ `console.error` **打全错**后放行；网络异常 → 放行。

⚠️ `CONTENT_CHECK_AI_REPLY` 开关在文档与注释中被提及，**代码中未实现**。

---

## 12. 已知问题与后续

| 问题 | 状态 / 去向 |
|---|---|
| ima 订阅库不可 API 检索（220030） | 降级为可选补充；后续改**教辅切片自建检索（pgvector）**（ADR-009） |
| 文科题召回优化 | 待办 |
| **AI 输出质量评估机制缺失** | 登记 OPS-18 |
| `kb` 来源入库后不可区分 / `'mixed'` 不在枚举中 | 登记 OPS-18 |
| `/api/chat` 与 AI 回复无"AI 生成"标注、不过内容安全 | 待办 |
| `answer_cache` 无启用开关 | 待办 |
| 客服历史"最早 20 条"与注释不符 | 待确认是否修正 |

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：三模式严格边界与互不兜底、接口契约与 `force` 代价、ima 认证与三条红线（含订阅库 220030 现状）、探针链与调用预算 **最坏 4 次/题**、LLM 三 provider 降级链与三条硬约束、对话端点的权限与上下文口径、两级缓存与配额（**超限是 200 非 429**）、八种失败文案、前端徽标与采纳安全阀、内容安全接入点与 openid 必填、七项已知问题。**同步订正提纲旧口径**：ima"最坏 12 次 / 6 库并行"已压缩为 4 次 |
