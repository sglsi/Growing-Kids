# 更新清单：canvas-v3 之后的全部改动

> 覆盖范围：`growing-kids-fixes-canvas-v3.zip`（2026-09-27 21:38）**之后**的所有更新，
> 含已发包 round6 / round7，以及 round7 之后未打包的改动。
> 所有文件均为**当前最新内容**（不是当时的中间版本），按原目录结构覆盖即可。
>
> 共 42 个文件。本清单未列出的文件 = 与 canvas-v3 一致，无需覆盖。

---

## 一、本包解决了什么

| 问题 | 现象 | 根因 | 状态 |
|---|---|---|---|
| 裁剪飞出框选范围 | 拖框裁出来的图不是框里的内容 | 画布坐标与图像坐标换算 | 已修 |
| 旋转放大 | 旋转后图片被放大/变形 | 旋转后画布尺寸未同步 | 已修 |
| 去手写点击无反应 | 前端无提示、后端无输出 | 成功路径未读 `debug.notice` | 已修 |
| 自动调正"点了没反应" | 侧拍试卷点了没变化 | 纸面占满画面时无透视校正路径 | 已修 |
| 自动调正"越点越歪" | 本来正的图被修歪 | **单应矩阵方向用反** | 已修 |
| 智能高清点击无反应 | 同上 | 成功路径未读 `debug.notice`（后端静默返回原图，前端当成功处理） | **提示层已修**；增强能力本身属"问题三"，本包未触碰 |
| 四角拉框无确认按钮 | 拉完不知道怎么提交 | 缺少确认交互 | 已修 |
| 确认四角后未裁剪 | 点了确认图没变 | 单应矩阵方向用反 | 已修 |
| 首页题目串题 | 选中 A 题打开 B 题 | 列表 key / 索引错位 | 已修 |

---

## 二、文件清单

### push-ready（16）

| 文件 | 说明 |
|---|---|
| `server/src/image/image-dewarp.ts` | **核心修复**：`solveHomography(dst, ordered)` 方向修正；新增 perspective 编排（coarse-to-fine） |
| `server/src/image/image-perspective.ts` | **新增**：文本行 → 稳健模型 → 四角 → 单应，补齐满画面透视校正 |
| `server/src/image/image.service.ts` | debug 增加 `parallelBefore/parallelAfter`；三功能成功路径补 `notice` |
| `server/src/image/image-deskew.ts` | 倾斜估计 |
| `server/src/image/handwriting-mask.ts` | 去手写掩码 |
| `server/src/image/handwriting-segmenter.ts` | 去手写分割 |
| `server/src/image/image.types.ts` | 类型同步 |
| `server/src/image/image.controller.ts` | 接口层 |
| `server/src/timeline/timeline.service.ts` | 时间线 |
| `server/src/timeline/timeline.types.ts` | 时间线类型 |
| `src/components/image-editor.tsx` | 前端编辑器：四角确认、notice 弹窗 |
| `src/components/review-item-card.tsx` | 首页卡片：串题修复 |
| `src/pages/index/index.tsx` | 首页 |
| `src/services/api.ts` | 前端 API 层 |
| `docs/issue-rotate-and-pipeline.md` | 旋转与流水线说明 |
| `docs/issue-three-image-features.md` | 三功能说明 |

### demo（2）

`src/components/image-editor.tsx`、`src/services/api.ts`（与 push-ready 两线同步）

### dynamic-tests（22）

| 类别 | 文件 |
|---|---|
| 回归套件 | `run-issue-deskew-geom.ts`（44 项）、`run-issue-three-features.ts`（56 项）、`run-image-v4.ts`、`run-issue-more-fix.cjs`、`run-issue-rotate-pipeline.cjs`、`run-issue-save-crop.cjs` |
| 共享测量 | `lib/img-measure.ts` |
| 诊断探针 | `probe-*.ts`（blur / corners / dark-ink / deskew-diag / deskew-sign / erase-diag / erase-e2e / feature-sep / mask-diag / mask-quality / mask-tune / perspective-fix / seed-diag / sr-strength / three-features） |

### 根目录（2）

`工程教训录.md`、`问题2-自动调正修复说明.md`

---

## 三、回归状态（打包时实跑）

| 套件 | 结果 |
|---|---|
| `run-issue-deskew-geom` | PASS 44 / FAIL 0 |
| `run-issue-three-features` | PASS 56 / FAIL 0 |
| v3 / v4 / v5 / v6 | 24/0、37/0、26/0、61/0 |
| autodetect / nochange / pipeline | 4/0、8/0、14/0 |
| `tsc --noEmit` | 通过 |

跑法（在 `dynamic-tests/` 下）：

```bash
npx tsx run-issue-deskew-geom.ts
npx tsx run-issue-three-features.ts
```

---

## 四、部署与验证

1. 覆盖 `push-ready/` 与 `demo/` 下对应文件
2. 后端重新构建部署
3. `GET /api/image/capabilities` 应返回 200
4. 侧拍试卷点「自动调正」：响应 `debug.method === 'perspective'` 且 `parallelAfter < parallelBefore`
5. 前端重新构建

---

## 五、已知边界（诚实记录）

1. **全部验证数据来自 SVG fixture，未用真实拍照验证过。** 上线前建议拿 5~10 张真实侧拍试卷过一遍。
2. 手写混排场景下，自动调正残余不平行度约 1.0°（纯印刷场景 0.05°）。残余偏差主要来自**测量被手写走向干扰**，非算法缺陷。
3. `detectCornersCV` 在纸面占满画面时仍恒不命中，此时依赖新增的 `image-perspective.ts` 路径。
4. 护栏常量（`MIN_AREA_RATIO = 0.25`、`PERSPECTIVE_MIN_STD_DEG = 0.4`、`MIN_ROWS = 3`）基于 fixture 调出，真实场景可能需微调。
5. **智能高清（问题三）尚未开始**，本轮未触碰。
