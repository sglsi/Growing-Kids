# 唯一直相源声明 & 归档说明

> 立此文件的背景：曾因工作区存在 **8 个 `image-editor.tsx`、3 个后端副本**，
> 改动落在错误副本上，导致「同一个问题反复返工」。见 `工程教训录.md` **L13**。

---

## ✅ 唯一真相源（只改这里）

| 内容 | 路径 |
| --- | --- |
| **前端源码** | `push-ready/src/` |
| **后端源码** | `push-ready/server/src/` |
| **文档** | `push-ready/docs/` |
| **回归测试** | `dynamic-tests/` |
| **教训录** | `工程教训录.md` |

**所有改动一律落在 `push-ready/`。** 它对应的真实仓库结构 = `src/` + `server/`（见 `DEPLOY.md`）。

---

## 📦 已归档（`_archive/`，不再改动）

| 目录 | 内容 | 归档原因 |
| --- | --- | --- |
| `_archive/server-v4/` | 旧后端（**无 `straighten`/`enhance`**） | 被 push-ready/server 取代 |
| `_archive/app-v4/` | 旧前端 | 被 push-ready/src 取代 |
| `_archive/v4-fixes/` `v5-fixes/` `v6-fixes/` | 各阶段历史修复补丁 | 已并入 push-ready |
| `_archive/stage1-fixes/` | 阶段一修复 | 已并入 push-ready |
| `_archive/fixpatch/` | 临时补丁 | 已并入 push-ready |

> 归档 = **移动**，未删除。需要用旧版对照时可从 `_archive/` 取。

## ⚠️ 未归档（仍在使用）

| 目录 | 说明 |
| --- | --- |
| `demo/` | **完整可构建的 Taro 工程**（含 node_modules）。用于「真实构建验证」：把 `push-ready/src` 覆盖进来 → `npx taro build --type weapp`。**注意：它不是源码真相源，改动不要写在这里。** |
| `dynamic-tests/` | 回归测试。**其中 6 个旧测试**（`run-all.mjs` / `run-image.mjs` / `run-pdf-e2e.mjs` / `run-pdf-layout.mjs` / `run-quota.mjs` / `run-storage.mjs`）仍引用已归档目录，属历史测试；**当前有效测试见下方清单**。 |
| `server/` `migrations/` `tools/` 等 | 项目其它部分，未纳入本轮范围 |

---

## ✅ 当前有效的回归测试（全绿，253 断言）

```bash
cd /workspace/projects/dynamic-tests

# 图像管线各阶段
npx tsx run-image-v2.mjs      # 18
npx tsx run-image-v3.ts       # 24
npx tsx run-image-v4.ts       # 37
npx tsx run-image-v5.ts       # 26
npx tsx run-image-v6.ts       # 61
npx tsx run-ui-sr.mjs         # 24

# 问题 1：旋转后【保存】被裁（真根因：保存链路状态机）
npx tsx run-issue-save-crop.cjs        # 15
# 问题 1：canvas 加固（固定 CSS 方框 + 显式导出区域）
npx tsx run-issue-rotate.cjs           # 15
# 问题 2：AI 功能路由分流（真跑 controller）
TSX_TSCONFIG_PATH=/workspace/projects/server/tsconfig.json npx tsx run-issue-pipeline-e2e.ts   # 14
# 问题 2：旧版静态检查
npx tsx run-issue-rotate-pipeline.cjs  # 7
# 诊断：「图片没变 / 提示很快消失」的端到端根因
TSX_TSCONFIG_PATH=/workspace/projects/server/tsconfig.json npx tsx run-issue-nochange-e2e.ts   # 8
# 诊断：自动四角检测在真实场景图可用
TSX_TSCONFIG_PATH=/workspace/projects/server/tsconfig.json npx tsx run-issue-autodetect.ts      # 4
```

**运行方式**：所有 `run-issue-*.cjs/.ts` 均可在 `/workspace/projects/dynamic-tests` 下直接运行；
涉及后端源码的两个 `.ts` 需带 `TSX_TSCONFIG_PATH=/workspace/projects/server/tsconfig.json`（开启装饰器）。
