/**
 * Phase 3 前端 UI 动态测试：断言「智能高清 倍率/模式选择 UI」已正确接入。
 * 纯静态源码分析 + 契约核对（前后端字段一致）。
 * 运行：node /workspace/dynamic-tests/run-ui-sr.mjs
 */
import fs from 'fs'

const FE = '/workspace/projects/src/components/image-editor.tsx'
const API = '/workspace/projects/src/services/api.ts'
const DTO = '/workspace/projects/server/src/image/image.types.ts'
const SVC = '/workspace/projects/server/src/image/image.service.ts'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

const fe = fs.readFileSync(FE, 'utf8')
const api = fs.readFileSync(API, 'utf8')
const dto = fs.readFileSync(DTO, 'utf8')
const svc = fs.readFileSync(SVC, 'utf8')

console.log('[1] api.ts：processImage 支持 sr_scale / sr_mode')
ok('ProcessImageOpts 声明 sr_scale', /sr_scale\?:\s*2\s*\|\s*3\s*\|\s*4/.test(api))
ok('ProcessImageOpts 声明 sr_mode', /sr_mode\?:\s*'classical'\s*\|\s*'espcn'/.test(api))
ok('仅在 enhance 时附带 SR 参数', /action === 'enhance'/.test(api) && /extra\.sr_scale/.test(api) && /extra\.sr_mode/.test(api))
ok('请求体展开 extra', /\.\.\.extra/.test(api))

console.log('[2] image-editor.tsx：倍率/模式选项与状态')
ok('定义 SRScale 类型', /type SRScale = 2 \| 3 \| 4/.test(fe))
ok('定义 SRMode 类型', /type SRMode = 'classical' \| 'espcn'/.test(fe))
ok('SR_SCALES 含 x2/x3/x4', /SR_SCALES/.test(fe) && /value: 2/.test(fe) && /value: 3/.test(fe) && /value: 4/.test(fe))
ok('SR_MODES 含 标准/神经网络', /SR_MODES/.test(fe) && /'classical'/.test(fe) && /'espcn'/.test(fe))
ok('srScale 状态', /useState<SRScale>\(2\)/.test(fe))
ok('srMode 状态', /useState<SRMode>\('classical'\)/.test(fe))
ok('srPanelOpen 状态', /useState\(false\)/.test(fe) && /srPanelOpen/.test(fe))

console.log('[3] image-editor.tsx：交互逻辑')
ok('dispatchAi：enhance 先开面板', /dispatchAi/.test(fe) && /action === 'enhance'[\s\S]*setSrPanelOpen\(true\)/.test(fe))
ok('runEnhance 带参数调 handleAi', /runEnhance[\s\S]*handleAi\('enhance',\s*'智能高清',\s*\{\s*sr_scale:\s*srScale,\s*sr_mode:\s*srMode/.test(fe))
// 注：opts 现含 sr_scale/sr_mode（本阶段）与 manual_corners（Phase 1 四角 UI）；
//     第 4 参 degradedRetry 为限流降级重试标志。统一用宽松匹配，避免字段扩展后误报。
ok(
  'handleAi 接收 opts 并透传 processImage',
  /handleAi = async \([\s\S]*opts\?: \{[\s\S]*sr_scale\?: SRScale[\s\S]*sr_mode\?: SRMode[\s\S]*\}[\s\S]*processImage\(action, sourceUrl, opts\)/.test(fe),
)
ok('按钮改用 dispatchAi', /AI_ACTIONS\.map[\s\S]*dispatchAi\(action, label\)/.test(fe))
ok('面板渲染 srPanelOpen', /\{srPanelOpen && \(/.test(fe))
ok('倍率点击 setSrScale', /setSrScale\(s\.value\)/.test(fe))
ok('模式点击 setSrMode', /setSrMode\(m\.value\)/.test(fe))
ok('开始处理绑定 runEnhance', /onClick=\{runEnhance\}/.test(fe))
ok('取消关闭面板', /setSrPanelOpen\(false\)/.test(fe))

console.log('[4] 前后端字段契约一致')
ok('DTO 有 sr_scale', /sr_scale\?: 2 \| 3 \| 4/.test(dto))
ok('DTO 有 sr_mode', /sr_mode\?: 'classical' \| 'espcn'/.test(dto))
ok('service 读 dto.sr_scale', /dto\.sr_scale/.test(svc))
ok('service 读 dto.sr_mode / SR_MODE', /dto\.sr_mode/.test(svc) && /SR_MODE/.test(svc))

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail === 0 ? 0 : 1)
