# 更新包文件清单（stage2 之后 · 第二轮增量）

- 生成时间: 2026-09-27 +0800
- 文件总数: 32（+ 本清单与 PATCHING.md 共 34）
- 前置包:  `growing-kids-fixes-after-stage2.zip`（2026-09-27 08:12）

## 本包 = stage2 之后「新修改及增加」的全部内容

覆盖三块工作：**自动调正与智能高清重构（Phase 1–3）** → **SR 服务端限流/排队** → **临时用户保留期 30 分钟→24 小时的口径统一**。

## 含哪些阶段

| 阶段 | 内容 |
|---|---|
| Phase 1 | 几何纠偏：自动四角检测（误差 ~1.4px）、透视压平、手动拉四角 |
| Phase 2 | 智能高清：x2/x3/x4 × classical/ESPCN、OCR 一致性 |
| Phase 3 | 增强：OpenCV 自动角点、去手写 v2（`erase_v2`）、OCR 一致性回退 |
| 四角 UI | 前端双模式切换（矩形裁剪 / 四角透视），归一化 [0,1] 坐标 |
| SR 限流 | 双泳道并发闸 `SrGate` + 用户配额 `SrUserQuota` + 排队降级提示 |
| 口径统一 | 匿名/临时用户保留期 **30 分钟 → 24 小时**（仅文档口径；后端常量早已是 24h） |

## 按目录

- **server/src/image/**: 11 个文件（含新增 7 个）
- **server/src/ocr/**: 1 个（`ocr.module.ts`，为复用 ImageService）
- **server/**: `package.json`（新增 `@techstark/opencv-js` 依赖）
- **src/**: 3 个（编辑页 / 识别页 / api）
- **docs/**: 4 个
- **dynamic-tests/**: 7 个（新增图像与 UI 回归）
- **根文档**: 5 个

## 完整清单

### 后端（server/）
- `server/package.json` — 增 `@techstark/opencv-js@^5.0.0-release.1`
- `server/src/image/image.controller.ts` — 路由 + 限流错误豁免（429/503 不被 hybrid 兜底吞）
- `server/src/image/image.module.ts` — 引入 `OcrModule`
- `server/src/image/image.service.ts` — 自动调正 / SR / 四角还原 / 限流闸包裹
- `server/src/image/image.types.ts` — DTO：`manual_corners` / `sr_scale` / `sr_mode`
- `server/src/image/image-corners.ts` 🆕 — 自动四角检测
- `server/src/image/image-cv.ts` 🆕 — OpenCV WASM 懒加载
- `server/src/image/image-dewarp.ts` 🆕 — 透视压平（归一化四角 + 退化捕获）
- `server/src/image/image-curvedewarp.ts` 🆕 — 曲面 dewarp（实测不达标，恒返回 null）
- `server/src/image/image-quality.ts` 🆕 — 画质评估
- `server/src/image/image-superres.ts` 🆕 — 超分（classical + ESPCN）
- `server/src/image/sr-gate.ts` 🆕 — 并发闸 + 用户配额
- `server/src/ocr/ocr.module.ts` — 导出 OcrService 供 ImageService 复用

### 前端（src/）
- `src/components/image-editor.tsx` — 四角透视 UI + SR 面板 + 限流降级提示
- `src/pages/recognize/index.tsx` — 去手写按钮改用 `erase_v2`
- `src/services/api.ts` — `manual_corners` / `sr_*` 传参 + `ApiError`

### 测试（dynamic-tests/）
- `run-image.mjs`、`run-image-v2.mjs`(18)、`run-image-v3.ts`(24)、`run-image-v4.ts`(37)、`run-image-v5.ts`(26)、`run-image-v6.ts`(61)、`run-ui-sr.mjs`(24)

### 文档
- `docs/phase3-report.md` 🆕 — Phase 3 报告
- `docs/manual-corners-ui.md` 🆕 — 四角 UI 说明
- `docs/sr-rate-limit.md` 🆕 — SR 限流方案
- `docs/策略6-配额方案.md` — 清理口径 30 分钟→24 小时
- `自动调正与智能高清重构方案.md` 🆕 — Phase 1–3 总体方案
- `PRD-成长学习伙伴.md` — §5.4 生命周期口径改 24 小时
- `复习本与项目设计.md`、`安全与隐私设计方案.md` — 同上口径同步
- `策略6-配额方案.md`（根副本） — 同 `docs/` 副本

## 验证

- 后端 `tsc --noEmit` 0 错、`nest build` 通过
- 前端 `tsc --noEmit` 0 错
- 动态测试：18 + 24 + 37 + 26 + 61 + 24 = **190 项断言全绿**（另 run-image.mjs 为探索式无计数）
- SR 集成验证：并发 4 个 x4 → 1 个执行、3 个超时降级（符合 1 核设计预期）
