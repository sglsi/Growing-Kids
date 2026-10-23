# 更新包 · 打补丁指引（stage2 之后 · 第二轮增量）

本包内所有文件路径**已是仓库相对路径**，可直接覆盖到 `sglsi/Growing-Kids` 根目录：
后端在 `server/src/...`，前端在 `src/...`。**无需再做目录改名。**

> 本包是 `growing-kids-fixes-after-stage2.zip`（08:12）**之后的增量**。
> 两个包可**独立使用**（本包已包含自身所需的全部改动文件），也可以先打旧包再打本包。

## 本包覆盖范围

| 阶段 | 内容 |
|---|---|
| Phase 1 几何纠偏 | 自动四角检测（误差 ~1.4px）+ 透视压平 + 手动拉四角 |
| Phase 2 智能高清 | x2/x3/x4 × classical/ESPCN 超分 + OCR 一致性 |
| Phase 3 增强 | OpenCV 自动角点、去手写 v2（`erase_v2`）、OCR 一致性回退 |
| 四角 UI | 前端双模式（矩形裁剪 / 四角透视），归一化 [0,1] |
| SR 限流 | `SrGate` 双泳道并发闸 + `SrUserQuota` 用户配额 + 排队降级提示 |
| 口径统一 | 匿名/临时用户保留期 **30 分钟 → 24 小时**（文档口径统一；后端常量早已是 24h） |

## 方式一：直接覆盖（推荐）

```bash
# 在 Growing-Kids 仓库根目录
unzip -o growing-kids-fixes-after-stage2-plus-image.zip
git add -A
git commit -m "feat(image): 自动调正+智能高清(Phase1-3) + SR限流; docs: 临时用户保留期改24小时"
git push
```

## 方式二：先 dry-run 确认

```bash
unzip -l growing-kids-fixes-after-stage2-plus-image.zip   # 看将要覆盖的文件
# 确认无误后再 unzip -o
```

## 部署侧必做

1. **安装新增依赖**（`server/package.json` 已更新）：
   ```bash
   cd server && npm install        # 新增 @techstark/opencv-js
   ```
2. **配置环境变量**（SR 限流，均有默认值，可不配）：
   | 变量 | 默认 | 含义 |
   |---|:--:|---|
   | `IMG_SR_GATE` | `on` | `off` 一键回退无限流 |
   | `IMG_SR_CONCURRENCY_HEAVY` | `1` | 重任务并发权重和（1 核即 1） |
   | `IMG_SR_CONCURRENCY_LIGHT` | `2` | 轻任务并发数 |
   | `IMG_SR_QUEUE_MAX` | `8` | 排队上限 |
   | `IMG_SR_QUEUE_TIMEOUT_MS` | `20000` | 排队超时 |
   | `IMG_SR_USER_RATE` | `6` | 每用户每分钟 heavy 上限 |
   | `IMG_SR_USER_CONCURRENT` | `1` | 每用户 heavy 同时进行数 |
3. **重启后端**，跑类型检查与测试：
   ```bash
   cd server && npx tsc --noEmit && npx nest build
   cd ../dynamic-tests && for t in run-image-v2.mjs run-image-v3.ts run-image-v4.ts run-image-v5.ts run-image-v6.ts run-ui-sr.mjs; do npx tsx $t; done
   ```
   > 动态测试依赖 `tsx`；`dynamic-tests/node_modules` 是指向 `server/node_modules` 的符号链接（仓库内可能没有，按需自行 `npm i tsx`）。

## 口径变更提醒（务必同步）

**匿名/临时用户保留期由 30 分钟改为 24 小时**。本包已同步以下位置：
- 文档：`PRD-成长学习伙伴.md`、`复习本与项目设计.md`、`安全与隐私设计方案.md`、`策略6-配额方案.md`
- 后端常量：`server/src/users/users.types.ts`（`ANONYMOUS_TTL_MS = 24h`）——**该文件本就是 24h，故未含在本包**
- 前端提示文案（`profile` 页："数据仅保留 1 天"）本就与 24 小时等价，无需改

> 说明：若你的仓库里还并存着早期的 sql.js/SQLite 原型（`growing-kids-server`，内含 `TEMPORARY_TTL_MS`），
> 其中也已改为 24h；那个原型不属于本包的覆盖范围，如需一并更新请告知。

## 验证

- 后端 `tsc --noEmit` 0 错 / `nest build` 通过
- 前端 `tsc --noEmit` 0 错
- 动态测试 **190 项断言全绿**
  - run-image-v2(18) / v3(24) / v4(37) / v5(26) / v6(61) / run-ui-sr(24)
