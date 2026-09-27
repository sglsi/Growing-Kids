# 更新包 · 打补丁指引（v6-stage2 之后）

本包内所有文件路径**已是仓库相对路径**，可直接覆盖到 `sglsi/Growing-Kids` 根目录：
后端在 `server/src/...`，前端在 `src/...`（与 stage2 的 PATCHING.md 一致）。
**无需再做目录改名**——之前的 stage3~v8 包内部用的是 `server-v4`/`demo` 名字，导致路径对不上，
本包已统一还原为仓库结构。

## 覆盖范围

| 阶段 | 内容 |
|---|---|
| v6-stage3 | 图片黑屏、首页再编辑、微信登录兜底 |
| v6-stage4-p1 | 登录修复 |
| v6-stage4-p2 | 裁剪修复 |
| v7 | PDF 多图拼页 |
| v8 | 存储优化：内容寻址去重 / 缩略图三档 / 临时对象通道 |
| 后续增量 | 策略 3 生命周期分层 + 策略 6 配额（逻辑口径、用量接口、413 预检） |
| 文档 | 安全与隐私设计方案、策略 3/6 配置与方案、存储优化实现说明 |

> 附带：`dynamic-tests/`（回归测试）、`tools/`（危险命令检测器）、`pdf-demo/`（拼页示例），
> 均为工程资产，非运行时必需，但建议一并提交以便回归。

## 方式一：直接覆盖（推荐）

```bash
# 在 Growing-Kids 仓库根目录
unzip -o growing-kids-fixes-after-stage2.zip
git add -A
git commit -m "fix: stage3~v8 + 存储优化 + 配额/分层 + 安全隐私文档"
git push
```

## 方式二：先 dry-run 确认

```bash
unzip -l growing-kids-fixes-after-stage2.zip   # 看将要覆盖的文件
# 确认无误后再 unzip -o
```

## 部署侧必做

1. **执行迁移（幂等，可反复跑）**，顺序执行：
   - `migrations/0003_blob_dedup.sql`
   - `migrations/0004_thumb_columns.sql`
   - `migrations/0005_quota_and_tiering.sql`
2. **配置环境变量**：`WX_APPID` / `WX_SECRET`（微信登录）、`QUOTA_MODE`（默认 `warn`，可选 `off|shadow|warn|block`）。
3. **重启后端**，跑类型检查与测试：
   ```bash
   cd server && npx tsc --noEmit
   cd ../dynamic-tests && node run-all.mjs && node run-storage.mjs && node run-quota.mjs
   cd ../demo && npx taro build --type h5
   ```

## 关于 `app-v4/`

包内含 `app-v4/`（第二前端，与 `src/` 同源但配置不同）。主仓库当前只有 `src/`，
**如你不维护 app-v4，可忽略该目录**；若维护，请按需并入你的前端工程。

## 验证

- 后端 `tsc --noEmit` 0 错
- `dynamic-tests`：run-all(41) / run-storage(78) / run-quota(95) 全绿
- 前端构建通过
- 配额：上传超量返回 413（`QUOTA_BYTES`/`QUOTA_COUNT`）；用量接口 `/api/quota/usage`
- 分层：`GET /api/storage/tier-stats` 可出报告（需先配云侧 4 条生命周期规则，见策略 3 文档）
