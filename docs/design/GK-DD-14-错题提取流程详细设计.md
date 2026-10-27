# GK-DD-14 错题提取流程详细设计

> 编号：GK-DD-14 ｜ 版本：v1.0 ｜ 日期：2026-10-27 ｜ 状态：**正文完成**
> 读者：前端 / 算法 ｜ 上游：SRS-01、DD-10 ｜ 下游：QA-15、OPS-18
> 定位：拍照 → 多页 → 识别 → 条目切分 → 编辑 → 入题 的**完整业务状态机**。
> 边界：识别算法见 DD-10，图像编辑见 DD-08 第 11 章，接口见 ADD-06，本文讲流程与数据结构。
> 主战场：`src/pages/recognize/index.tsx`（2080 行）+ 三个 wrongq 组件。

---

## 1. 文档目的与范围

本文讲"**错题提取页怎么跑**"。历史专题报告（错题提取技术文档、真实作业验收报告、PaddleOCR 接入验证、成果留存索引）的结论并入本文，原文件保留为过程留档（GK-00 第 6.2 章）。

---

## 2. 流程总览

### 2.1 三种模式

| 模式 | 入口 | 识别接口 | 结果结构 | 自动切题 |
|---|---|---|---|---|
| `paper` 拍照识别 | 首页写入 `recog_mode='paper'` 后跳转 | `POST /api/ocr/recognize-exam` | `Draft[]` | ✅ |
| `split` 错题提取 | `recog_mode='split'` | `POST /api/image/ocr-page`（逐页/逐题） | `BoardEntry[]` | ❌ **人工** |
| `doc` 导入文档 | `recog_mode='doc'` | `POST /api/ocr/recognize-doc`（**240s 超时**） | `Draft[]` | ✅ |

- `recog_mode` 由首页写入 storage，识别页挂载时读取**且读完即删**（只生效一次）；
- 学科列表挂载即拉；默认学科取 `list[1]?.id || list[0]?.id`（⚠️ **下标 1 是硬编码偏好**，非业务语义）。

### 2.2 `paper` / `doc` 状态机

```
S1 选图/选文件        chooseMedia（单张）/ chooseMessageFile（pdf/doc/docx/txt）或资料库 URL
   ↓
S2 图像编辑（可选）   裁剪 / 自动调正 / 智能高清 / 去手写（不落库，仅回填）
   ↓
S3 识别              recognizePaper / recognizeDocumentByUrl → 清空旧 drafts
   ↓
S4 草稿编辑          题干/答案 Textarea、逐题学科 Picker、删除
   ↓
S5 勾选              selected（undefined = 选中 ⇒ 默认全选）
   ↓
S6 入题              createTimelineBatch（一次批量落库）
   ↓
S7 保存后            Modal：「另存 Word」/「完成」→ navigateBack
旁路                 图片直存（不 OCR）→ purpose='save' + saveQuestionAsImage
```

**失败分支**：无图/无学科 → toast；空结果 → 抛「未识别到题目…」；识别异常 → toast `e.message`。

### 2.3 `split` 状态机（人工辅助，当前主入口）

```
S0 初始化            board = [1 条空条目]（用户删光后不补）
S1 选页（可多选）     ≤9 页 → 逐个 uploadImage → BoardPage{ocr:'idle'}
S2 页操作            切换 / 看大图 / 失败重试（沿用 lastMode）/ 点图进全功能编辑
S3 整页 OCR（次要）  ocrPage(url, mode) → 回填 image_url + page + page_text + orient_suspect
S4 条目管理          增删 / 排序 / 文本（≤30 题）
S5 裁剪入题          ImageEditor cropOnly → uploadImage(purpose:'attach') → e.images（每题 ≤9 图）
S6 本题 OCR          ocrPage(src, mode, { rectify: false })
S7 段落→题干         appendSegmentsToEntry / handlePasteToEntry（含三重分家守护）
S8 入题              createTimelineBatch（source='人工整理'）
旁路                 导出 Word / 打印（**仅 H5**）
```

⚠️ **自动链路已暂停**（`index.tsx:235-240`）：`handleLink`（双图上传 → `recognizeSeparate` → `extract-wrong`）**零 UI 调用点**，仅 `void handleLink` 占位过编译。代码全保留，恢复路径见 `docs/reports/错题自动识别-成果留存索引.md:105-111`。

因为 split 不再设置 `showEditor` / `pageText`，`WrongqBoxEditor` 与 `WrongqTextPanel` **当前不会渲染**。

---

## 3. 来源页管理（`split`）

### 3.1 数据结构

```ts
interface BoardPage {
  id: string
  url: string                                  // 公网可访问 URL
  w: number; h: number
  segments: PageTextSegment[]                  // 整页 OCR 段落
  ocr: 'idle' | 'busy' | 'done' | 'error'
  err?: string
  lastMode?: 'fast' | 'precise'                // 重试沿用上次模式
  suspect?: boolean                            // 朝向未经 OCR 消歧（可能侧躺）
}

interface BoardEntry {
  id: string
  text: string                                 // 题干（人工录入 / 段落粘贴）
  images: { url: string; key: string }[]       // ≤9 张
  segments: PageTextSegment[]
  ocr: 'idle' | 'busy' | 'done' | 'error'
  lastMode?: 'fast' | 'precise'
}
```

### 3.2 页面状态机与操作

| 操作 | 实现 | 约束 |
|---|---|---|
| 添加 | `Taro.chooseMedia(count: 剩余)` → 逐个 `uploadImage()` | **≤ 9 页** |
| 删除 / 排序 | `removeEntry` / `moveEntry` | — |
| 看大图 | — | — |
| 重新识别本页 | `retryPageOcr` 沿用 `lastMode` | — |
| 点图进编辑 | `handlePageImgEdited`（全功能 ImageEditor） | ⚠️ **换图即清空该页 segments** |

### 3.3 ⚠️ 摆正静默回落脏数据

侧车不可达时回落几何投影，**无法区分 90° / 270°** ⇒ 用 `orient_suspect` 标记并在前端 toast「本页可能侧躺」。

---

## 4. 版面分析与条目级切分

### 4.1 自动链路五阶段（`extract-wrong`，已暂停）

| 阶段 | 模块 | 职责 |
|---|---|---|
| ① 摆正 + 版面 | `wrongq-layout.ts` | UVDoc 矫正、栏结构检测 |
| ② 红笔检测 | `wrongq-mark.ts` / `wrongq-evidence.ts` | 红墨区 → 连通域 → 形态分类 → 书写簇分组 |
| ③ 条目级切分 | `wrongq-segment.ts` / `wrongq-structure.ts` | 题号定界单元 → 「节 → 小类」区间树 → 编号修复 → 二遍重切 |
| ④ 归属判定 | `wrongq-evidence.ts` | 红墨组 → 锚点评分 → `buildEvidenceBlocks` |
| ⑤ 裁图 + 条目 OCR | `wrongq-block.ts` | 块裁切、条目文字识别 |

色域与几何参数、组级门、置信度见 **DD-10 第 9 章**。

### 4.2 题号规则

**版面侧八级签名（优先级）**：括号中文 > 中文 > 圈码 > 罗马 > 括号阿拉伯 > 裸阿拉伯+分隔符 > 行首糊字 > 行尾裸数字。

**代码侧正则**（`ocr-hierarchy.ts:66-94`，见 DD-10 第 9.4 节）：`part` / `paren-cjk` / `cjk` / `circled` / `arabic`。

**大题级（父题）** = `cjk | paren-cjk | part`；**小题级（子题）** = `arabic | circled`。

### 4.3 `level` / `parent_index` 赋值规则（`inferHierarchy` + `linkHierarchy`）

| 规则 |
|---|
| **只填未标注的**——已由模型标注的一律尊重、不覆盖 |
| `parent_index` 有效 ⇒ `level = 2`；否则 `parent_index = null`，`level` 缺省补 1 |
| 存在大题级编号时按大题切段，段内小题编号类型取**众数**定 `subKind` |
| 父题显式声明「完成 1-3 题」（`parseDeclaredRange`）⇒ 只认 `arabic`，且必须连续落在范围内，否则不挂 |
| 序列起点可为任意编号（跨页试卷小题可能从 11 起） |
| **断档** ⇒ 本题开启新序列（三层结构「三、实验题 > 17. >（1）」折为两层，让（1）挂 17 题） |
| 无大题但有圈码 ⇒ ①②③ 紧跟的前一道非圈码题视为父题 |
| 全篇仅阿拉伯数字编号时**不建立父子**（避免大题互挂） |

### 4.4 `stem` 与 `question_label` 的产出时机

| 字段 | 规则 |
|---|---|
| `stem`（顶层题） | = 自身题面（模型已给则保留） |
| `stem`（子题） | = 父题**原始**题面（非父题被拼接后的全文） |
| 子题 `question_content` | 若不含父题全文 ⇒ 前置拼接 `父题全文\n子题原文`；空则直接取父题全文 |
| 处理顺序 | 按层级深度**升序**（先定完父题完整题面，子题才继承正确） |
| `question_label` | 后端结构层产出（`WrongqBlock.questionLabel`，含「节·小类 题号」）→ 逐块回填 → 前端落库 `content.question_label`；**recrop 时原样带回**（框变更不重跑结构分析） |

### 4.5 切分错误的常见形态与人工纠正

| 形态 | 纠正方式 |
|---|---|
| 框偏移 / 漏题 | 叠加编辑器拖动 / 空白处橡皮筋补捞 |
| 判错不准 | 手动改框 → `recropWrongBlock` |
| 图文分家 | 三重守护（见 §8.2） |

---

## 5. OCR 结果与文本分段

### 5.1 段落结构

`PageTextSegment = { text, box, col, kind, lines, source }`——**一个"段"不是一行**（`lines` 表示由几行合并）。

| `source` | 含义 |
|---|---|
| `layout` | precise：直接取 PP-StructureV3 的 blocks（已含阅读序） |
| `xycut` | fast：行级 → 递归 XY-Cut 定序 + 间隙/缩进/题号断段 |

`kind`：`text | title | table | formula | other`（`title` 在面板加粗显示）。分段算法与阈值见 DD-10 第 8.4 节。

### 5.2 前端消费

| 组件 | 作用 |
|---|---|
| `wrongq-ocr-panel` | 整页段落面板：可选中复制、分段采纳（复制单段 / 复制所选 / 全选清空） |
| `wrongq-text-panel` | 题目文本草稿面板（`TextPanelDraft = { idx, label }`，label = 题号标签 + 第 N 题） |

⚠️ 面板内交互元素**一律用 `View` 不用 `Text`**（Taro 4.1.9 `removeEventListener` 读 `componentsAlias['pure-text']` 崩溃，#16641）。

### 5.3 识别不准的兜底

重新识别本页（切换 fast/precise）· 手动编辑 · 段落采纳。

⚠️ **切「精准识别」会先清空上次段落**（换精准本就因效果不理想，避免新旧混杂）。

---

## 6. 裁剪为图片题目

**场景**：只裁剪、不识别、只存图（几何图形题、无法识别的手写）。

| 环节 | 约定 |
|---|---|
| 裁剪交互 | `ImageEditor` 的 `cropOnly` 模式（矩形 / 四角） |
| 坐标 | 页图像素口径；显示层按 contain 缩放 `s = pw / imgW` |
| 🔴 **上传 purpose** | **`attach`**——误用 `save` 会多建一条 `kind='image'` 记录，之后「存入错题库」再建一条 ⇒ **首页同一题显示两行** |
| key 归属 | 写入 `content.question_images`（答案图写 `answer_images`） |
| 兜底 | `title` = 「图片题目」，**允许无题干只有图**（后端校验已放宽） |

⚠️ **裁剪后不再自动识别**（旧行为白等 1~3s）；不识别也能入库。

---

## 7. 编辑与替换

| 场景 | 行为 |
|---|---|
| 来源页图片编辑 | 原位替换 `boardPages[pageIdx].url` |
| 题目图编辑 | 原位替换 `e.images[imgIdx]` |
| ⚠️ **两者都必须清空对应的 `segments`** | 否则文字与图不一致（旧 OCR 段落作废） |
| 条目内文字编辑 | Textarea + `math-symbol-bar`（见 DD-08 第 10 章） |

---

## 8. 入题与去重

### 8.1 批量保存 payload

```ts
// paper / doc
{
  kind: 'question',
  subject_id: d.subject_id,
  source: d.source,
  content: {
    question: d.question_content,
    answer: d.answer_content || '',
    solution: d.solution || '',
    wrong_answer: d.wrong_answer || '',
    status: (d.has_answer || d.answer_content) ? 'answered' : 'pending',
    question_images: d.question_image_keys || [],
    answer_images:  d.answer_image_keys  || [],
    level: d.level,
    parent_index: remap.get(d.parent_index) ?? null,   // ⚠️ 必须重映射
    stem: d.stem || '',
    question_label: d.question_label,
  },
}

// split
{ kind:'question', subject_id: sid, source:'人工整理',
  content:{ question: e.text.trim(), answer:'', solution:'', wrong_answer:'',
            status:'pending', question_images: e.images.map(i => i.key) } }
```

**关键**：

- ⚠️ `parent_index` 是**同批次数组下标**，部分保存时**必须重映射**；父题未勾选的子题 `parent_index = null` 并升为顶层（题干已随 `stem` 携带，数据自洽）；
- **不再双写 `images[]`**（P1-15，前端只读 `question_images` / `answer_images`）；
- **一次批量落库**（`POST /api/timeline/batch`），不再循环单条请求。

### 8.2 ⚠️ 图文分家三重守护（历史真 bug 源）

| # | 守护 | 位置 |
|---|---|---|
| 1 | 裁剪图必须 `purpose: 'attach'`（误用 `save` 会多建条目） | `index.tsx:999-1007` |
| 2 | 「+存入新题目」遇「有图无文字」题 ⇒ 弹合并确认 | `:1067-1095` |
| 3 | 落库前「1 图 + 1 文字」签名守护：限定 `imgOnly` 必须 `segments.length > 0`，否则误报 | `:790-796` |

### 8.3 去重与幂等

⚠️ **当前无"同一页重复点保存"的去重**：保存按钮在 `saving` 期间禁用，但保存成功后返回识别页仍可再次保存 ⇒ 会重复建条目。登记 OPS-18。

### 8.4 保存后

| 模式 | 行为 |
|---|---|
| paper / doc | Modal：「另存 Word」/「完成」→ `setTimeout(navigateBack, 200)` |
| split | 仅 toast「已存入错题库 N 题」，**不跳转** |

**缓存失效**：`createTimelineBatch` → `invalidateAfter(..., 'tl')`；上传侧按 purpose 判域（见 DD-13 第 3.3 节）。

**匿名提醒**：`nudgeLoginIfAnonymous()`。

---

## 9. 状态机与异常处理

| 异常 | 用户可见提示 | 可恢复动作 |
|---|---|---|
| 未选图 / 未选学科 | toast「请先选择图片」/「请先选择学科」 | 补选 |
| 学科列表未就绪 | toast「学科列表未就绪，请确认后端已启动后重试」 | 重启后端 |
| 识别空结果 | 「未识别到题目，请确认内容为文字/清晰」 | 换图 / 换模式 |
| 识别失败 | toast `e.message` | 重试 |
| **文档识别超时** | 「文档识别超时（240s），请减少页数或改用图片识别」 | 减页数 |
| 整页 OCR 超时 | `ocrPage` 180s（微信上限 300s） | 重试 / 换 fast |
| 配额耗尽（`QUOTA_MODE=block`） | 上传被拦截 | 清理旧数据 |
| 切块数量超限 | `MAX_EXTRACT_BLOCKS = 60` | 拆分页面 |
| 本页可能侧躺 | toast「本页可能侧躺」 | 手动旋转 |
| 旧版 `.doc` | 明确报错「请用 Word 另存为 .docx 或导出 PDF 后识别」 | 转换格式 |

⚠️ **草稿暂存策略缺失（风险）**：草稿仅存在于页面内存，**切后台被销毁 / 误触返回 / 小程序重启 ⇒ 全部丢失**，无恢复机制。登记 OPS-18。

⚠️ **多题合并不可撤销**（`index.tsx:498`）。

---

## 10. 验收结果

### 10.1 三轮真实作业验收（`docs/reports/错题提取-真实作业验收报告.md`）

样本：两张英语作业照片（正面 6 错 / 背面 3 错，1920×1440 横躺无 EXIF）。

| 轮次 | 结论 |
|---|---|
| Round 0 基线 | 综合 F1 **21%**，查准 **15%**（红笔几乎划满全页） |
| Round 1 | 块数 100→86，进入识别 51→41，重复率 0.098→0，题号召回零损失；IoU 阈值定为 **0.85** |
| Round 2 | 判卷语义化：correction→wrong 0.7；否定符号→0.6；红圈→0.55；对勾→correct 0.5 |
| Round 3（R1/R2/R3） | **9/9 = 100% 稳定，0 误报，0 存疑** |

| 最终指标 | 值 |
|---|---|
| **判定召回 / 查准 / F1（核心）** | **100% / 100% / 100%** |
| 裁图完整性 | 9/9 |
| 题号字段提取 | 6/9 = **67%** |
| `question_content` 含题号上下文 | 7/9 = **78%** |
| 文本层 F1（自动匹配订正文字） | **25%** |
| 红笔订正文字 OCR | ❌ 基本读不出 |
| 手写学生作答 OCR | ❌ 乱码 |

### 10.2 PaddleOCR 3.7.0 接入验证

四页英语作业 + 学案正/反夹具：

| 页 | 题块 | verdict=wrong | item(wrong) | 耗时 |
|---|---|---|---|---|
| p1-unit1-A | 8 | 8 | 4 | 99s |
| p2-unit1-A | 12 | 12 | 12 | 117s |
| p3-unit1-B | 5 | 5 | 5 | 97s |
| p4-unit2-A | 13 | 13 | 13 | 136s |
| **合计** | **38** | **38** | **34** | — |

| 域 | 结果 |
|---|---|
| GT 学案·正面召回 | **6/6 = 100%**（4 订正词 + 2 划改，含 17 红圈）；**误报 13 块**（全部 strike-only） |
| GT 学案·背面召回 | **1/3**（Ⅰ.4 归属偏移 + 选词 14 单元缺失） |
| 用户目验四页 | 实际 0/2/5/3，系统标出 8/12/5/13 ⇒ **p1 全误报、p2 大量误报、p3 数量对但位置基本不正确、p4 大量误报且分栏未分开** |

🔴 **架构决策**：自动错题提取**推迟到项目后期**，改交付**人工辅助流程**（即当前 `split` 模式）。

### 10.3 红笔检测与条目级切分（四轮 A/B：F0 → G0 → G3 → G4）

| 页面 | 真值错题 | units F0→G4 | blocks F0→G4 |
|---|---|---|---|
| p1-unit1-A | 0 | 46→46 | 8→**5** |
| p2-unit1-A | 2 | 21→22 | 12→**13** |
| p3-unit1-B | 5 | 14→27 | 5→**11** |
| p4-unit2-A | 3 | 37→48 | 13→**11** |
| gt-front | 6 | 13→20 | 3→**3** |
| gt-back | 3 | 11→14 | 8→**10** |

**红笔 GT 命中**：gt-back **3/3 全覆盖**；gt-front **1/6**（"完成句子 4/5/8/11/17"题号被 OCR 系统性吞吃）。

### 10.4 残留问题（登记 OPS-18）

| # | 问题 |
|---|---|
| 22 | **归属偏移**（Ⅰ.4 类）：strike 组横跨相邻单元边界时按组心归属 ⇒ 错判给下一题；修正需组顶边/重叠度加权，**本轮未改**（会波及主战场，需单独 A/B） |
| 23 | **完形行单元缺失**：PP-StructureV3 把完形行合并为长行，题号不在行首 ⇒ 编号入口失效；需超长 region 行内二次切分，**未改** |
| 24 | 🔴 **两域批阅约定冲突**：学案页教师用红笔划线/打勾强调**答对**的条目，与作业页"红圈+划改=错"**语义相反**；六页标定证实形态完全同构，**无本地信号可分离**。缓解 = 置信分层 + 手动改框 |
| 25 | gt-front 题号被 OCR 系统性吞吃 |
| 26 | p1「答案 Key 式红订正」语义口径待求证（若页面是答案 Key 页，现行内核会 FP） |
| 27 | p2/p3/p4 检出块数 vs 真值计数差，指向「哪些红订正算错题」的口径问题，**需用户裁决** |
| 28 | item 文本质量：34 条中订正/答案多为空；文本补全依赖 VLM 语义层 |
| 29 | 🔴 RapidOCR 是印刷体模型，红笔连笔/手写读不出 ⇒ **接 VLM 是唯一能同时解决「读红笔字」与「分辨划线 vs 订正」的方案** |

### 10.5 其它边界

- 人工流上限：**9 页 / 30 题 / 每题 9 图**（防滥用 + 控导出体积）；
- 合并**仅支持相同学科**且**不可撤销**；
- **打印仅 H5**：非 Web 环境引导「导出 Word」后打印/转发；
- PDF 页数截断：文字页 50、扫描页 8（可用 `OCR_PDF_MAX_*_PAGES` 调）；
- 微信小程序**读不到系统剪贴板中的图片**（只能粘贴文字）⇒ 「粘贴手截错题图」落为**页内裁剪**。

---

## 变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.0 | 2026-10-24 | 建立提纲（待审） |
| v1.0 | 2026-10-27 | **正文完成**：三模式状态机（含 split 人工流为当前主入口、自动链路已暂停）、来源页数据结构与状态机、条目级切分五阶段与题号八级签名、`level`/`parent_index` 八条规则、`stem`/`question_label` 产出时机、文本分段与前端消费、裁剪存图的 `attach` 铁律、编辑替换清 segments、批量保存 payload 与 `parent_index` 重映射、图文分家三重守护、异常处置 10 类、三轮验收数据与 9 项残留问题（含两域批阅语义冲突、VLM 是唯一解法） |
