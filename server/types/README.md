# 说明

本目录下的 `*.check-only.d.ts` 是**仅用于本地类型检查**的依赖声明桩（真实运行时由 Coze 平台 / npm 依赖提供）。
**不要**把它们复制进仓库（仓库已装真实依赖）。保留在此仅为让交付代码可被 `tsc` 独立校验。

| 文件 | 覆盖的模块 |
|---|---|
| `coze-coding-dev-sdk.check-only.d.ts` | `coze-coding-dev-sdk`（S3Storage / LLMClient / FetchClient / SearchClient…） |
| `supabase-js.check-only.d.ts` | `@supabase/supabase-js`（链式查询 API 形状） |
| `libs.check-only.d.ts` | `docx` / `pdf-lib` / `multer` |
| `express-multer.check-only.d.ts` | `global.Express.Multer.File` 命名空间补丁 |

## 本地校验方法

```bash
# 在 server-v4/ 下：
ln -s <装了依赖的目录>/node_modules node_modules
tsc -p tsconfig.check.json   # tsconfig.check.json 为临时生成，不入库
```

`tsconfig.check.json` 关键点：`extends ./tsconfig.json`，`noEmit: true`，`types: ["node"]`，
`include: ["src/**/*.ts", "types/**/*.d.ts"]`。
校验通过后记得删除 `node_modules` 软链与临时 tsconfig——本目录交付物应保持纯净。
