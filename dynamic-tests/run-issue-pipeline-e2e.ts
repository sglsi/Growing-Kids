/**
 * 问题 2 端到端验证（真跑后端 controller 路由 + 真跑几何算法）
 *
 * 目的：证明「自动调整 / 智能高清 / 去手写」在**默认配置**下都会进入能工作的新路径，
 *       而不是被 IMG_PIPELINE_MODE 静默导向旧路径（"点了没反应"的真因）。
 *
 * 运行：npx tsx /workspace/dynamic-tests/run-issue-pipeline-e2e.ts
 * 依赖：push-ready/server（含 @nestjs/common、sharp、coze-coding-dev-sdk）
 */
import * as path from 'path'
import { createRequire } from 'module'
const require = createRequire(path.join('/workspace/projects/server/', 'noop.js'))

let pass = 0, fail = 0
function ok(name: string, cond: any, extra?: string) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')) }
}

const SERVER = '/workspace/projects/server'
const SRC = path.join(SERVER, 'src')

function freshController(envMode?: string) {
  if (envMode === undefined) delete process.env.IMG_PIPELINE_MODE
  else process.env.IMG_PIPELINE_MODE = envMode
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}image${path.sep}image.controller`)) delete require.cache[k]
  }
  const { ImageController } = require(path.join(SRC, 'image/image.controller.ts'))
  const calls: string[] = []
  const fakeService: any = {
    eraseV2: async () => { calls.push('eraseV2'); return { url: 'u', key: 'k', timeline_id: '' } },
    straighten: async () => { calls.push('straighten'); return { url: 'u', key: 'k', timeline_id: '' } },
    enhance: async () => { calls.push('enhance'); return { url: 'u', key: 'k', timeline_id: '' } },
    process: async () => { calls.push('process'); return { url: 'u', key: 'k', timeline_id: '' } },
  }
  const ctrl = new ImageController(fakeService)
  const req: any = { headers: {}, userContext: { userId: 'u1' }, userId: 'u1' }
  return { ctrl, calls, req }
}

async function main() {
  console.log('==== 问题 2 端到端：action 路由分流 + 几何算法真跑 ====\n')

  console.log('[1] 默认模式（不设 IMG_PIPELINE_MODE）')
  {
    const { ctrl, calls, req } = freshController(undefined)
    await ctrl.process({ action: 'auto', image_url: 'http://x/a.jpg' } as any, req)
    ok("默认下 'auto' → straighten（几何纠偏）", calls.includes('straighten'), 'calls=' + JSON.stringify(calls))
  }
  {
    const { ctrl, calls, req } = freshController(undefined)
    await ctrl.process({ action: 'enhance', image_url: 'http://x/a.jpg' } as any, req)
    ok("默认下 'enhance' → enhance（智能高清）", calls.includes('enhance'), 'calls=' + JSON.stringify(calls))
  }
  {
    const { ctrl, calls, req } = freshController(undefined)
    await ctrl.process({ action: 'erase_v2', image_url: 'http://x/a.jpg' } as any, req)
    ok("默认下 'erase_v2' → eraseV2（去手写）", calls.includes('eraseV2'), 'calls=' + JSON.stringify(calls))
  }

  console.log('\n[2] 显式 IMG_PIPELINE_MODE=gen（旧行为，反例：功能被关）')
  {
    const { ctrl, calls, req } = freshController('gen')
    await ctrl.process({ action: 'auto', image_url: 'http://x/a.jpg' } as any, req)
    ok('gen 模式：auto 落 process（新管线被关）', calls.length === 1 && calls[0] === 'process', 'calls=' + JSON.stringify(calls))
  }
  {
    const { ctrl, calls, req } = freshController('gen')
    await ctrl.process({ action: 'enhance', image_url: 'http://x/a.jpg' } as any, req)
    ok('gen 模式：enhance 落 process（新管线被关）', calls.length === 1 && calls[0] === 'process', 'calls=' + JSON.stringify(calls))
  }
  {
    const { ctrl, calls, req } = freshController('gen')
    await ctrl.process({ action: 'erase_v2', image_url: 'http://x/a.jpg' } as any, req)
    ok('gen 模式：erase_v2 仍直达 eraseV2（不受开关影响）', calls[0] === 'eraseV2', 'calls=' + JSON.stringify(calls))
  }

  console.log('\n[3] hybrid：新管线异常应回退 process（不硬失败）')
  {
    const { ctrl, req } = freshController('hybrid')
    ;(ctrl as any).imageService.straighten = async () => { throw new Error('几何纠偏炸了') }
    const calls: string[] = []
    ;(ctrl as any).imageService.process = async () => { calls.push('process'); return { url: 'u', key: 'k', timeline_id: '' } }
    const r: any = await ctrl.process({ action: 'auto', image_url: 'http://x/a.jpg' } as any, req)
    ok('hybrid：straighten 抛错 → 回退 process 并返回成功', calls.includes('process') && r.code === 200, 'calls=' + JSON.stringify(calls))
  }
  {
    const { ctrl, req } = freshController('new')
    ;(ctrl as any).imageService.straighten = async () => { throw new Error('几何纠偏炸了') }
    let threw = false
    try { await ctrl.process({ action: 'auto', image_url: 'http://x/a.jpg' } as any, req) } catch { threw = true }
    ok('new：straighten 抛错 → 原样抛出（不吞错）', threw)
  }

  console.log('\n[4] 限流错误（429/503）不得被 hybrid 兜底吞掉')
  {
    const { ctrl, req } = freshController('hybrid')
    const { HttpException, HttpStatus } = require('@nestjs/common')
    ;(ctrl as any).imageService.enhance = async () => { throw new HttpException('被限流', HttpStatus.TOO_MANY_REQUESTS) }
    let threw = false, status: any = null
    try { await ctrl.process({ action: 'enhance', image_url: 'http://x/a.jpg' } as any, req) }
    catch (e: any) { threw = true; status = e.getStatus && e.getStatus() }
    ok('hybrid：enhance 429 → 原样抛出（不被兜底掩盖）', threw && status === 429, 'status=' + status)
  }

  console.log('\n[5] 真跑 straightenImage（真造像素）—— 功能本身必须可用')
  {
    const sharp = require('sharp')
    const { straightenImage } = require(path.join(SRC, 'image/image-dewarp.ts'))
    const W = 900, H = 1200
    const svg = `<svg width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#333"/>
      <polygon points="120,80 780,160 700,1120 180,1040" fill="#f5f5f5"/>
      <text x="450" y="600" font-size="60" fill="#111" text-anchor="middle">TEST PAGE</text>
    </svg>`
    const src = await sharp(Buffer.from(svg)).jpeg().toBuffer()
    const r: any = await straightenImage(src, {
      manualCorners: [[120, 80], [780, 160], [700, 1120], [180, 1040]],
      auto: true,
      curved: false,
    })
    ok('straightenImage 返回结果对象', !!r, 'keys=' + Object.keys(r).join(','))
    ok('straightenImage 未要求手动（有明确四角）', r.needManual === false, 'needManual=' + r.needManual)
    ok('straightenImage 产出 buffer', !!r.buffer && r.buffer.length > 0, 'bytes=' + (r.buffer ? r.buffer.length : 0))
    if (r.buffer) {
      const m = await sharp(r.buffer).metadata()
      ok(`straightenImage 输出尺寸有效 ${m.width}x${m.height}`, m.width > 0 && m.height > 0)
      const ratio = m.width / m.height
      ok('straightenImage 输出近似矩形（宽高比合理 0.4~1.2）', ratio > 0.4 && ratio < 1.2, 'ratio=' + ratio.toFixed(3))
    }
  }

  console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
