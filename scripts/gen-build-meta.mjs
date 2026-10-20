// 构建前自动生成：把构建时间与 git 短哈希写进 src/build-meta.ts，
// 供小程序内显示「版本角标」——真机上一眼确认跑的是不是最新包。
// 由 package.json 的 build:weapp / dev:weapp 前置执行；请勿手改生成物。
import { writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

let commit = 'unknown'
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8' }).trim()
} catch {
  /* 非 git 环境（如副本目录）时留 unknown */
}

const content = `// 构建时自动生成（scripts/gen-build-meta.mjs），请勿手改
export const BUILD_META = {
  time: '${time}',
  commit: '${commit}',
  label: '${time.slice(5)} · ${commit}',
}
`

const out = path.join(root, 'src', 'build-meta.ts')
writeFileSync(out, content, 'utf-8')
console.log(`[gen-build-meta] ${time} · ${commit} -> src/build-meta.ts`)
