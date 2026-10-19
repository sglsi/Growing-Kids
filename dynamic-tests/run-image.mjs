// 动态测试：去手写/自动调正/智能高清 可用性修复的一致性断言
// 运行：node dynamic-tests/run-image.mjs
import { readFileSync, existsSync } from 'node:fs'

let pass = 0
let fail = 0
const fails = []
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    fails.push(name)
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

// 需要校验的文件
const files = {
  demoApi: 'demo/src/services/api.ts',
  demoEditor: 'demo/src/components/image-editor.tsx',
  demoRecognize: 'demo/src/pages/recognize/index.tsx',
  appApi: 'app-v4/src/services/api.ts',
  appEditor: 'app-v4/src/components/image-editor.tsx',
  appRecognize: 'app-v4/src/pages/recognize/index.tsx',
  imgService: 'server-v4/src/image/image.service.ts',
  imgController: 'server-v4/src/image/image.controller.ts',
}

console.log('\n【一、去手写必须走 erase_v2（正确的本地 mask+修复 路径）】')
// ImageAction 类型声明只在 api.ts 中；editor/recognize 仅 import 它
for (const [k, f] of Object.entries(files)) {
  if (k === 'imgService' || k === 'imgController') continue
  if (k.endsWith('Api')) {
    const typeOk = /ImageAction\s*=\s*'auto'\s*\|\s*'enhance'\s*\|\s*'erase'\s*\|\s*'erase_v2'/.test(read(f))
    check(`[${k}] ImageAction 类型含 'erase_v2'`, typeOk)
  } else {
    const importsType = /ImageAction/.test(read(f))
    check(`[${k}] 引用 ImageAction（类型来自 api.ts，已含 erase_v2）`, importsType)
  }
}
check('demo image-editor 去手写按钮 action=erase_v2',
  /\{ action: 'erase_v2', label: '去手写'/.test(read(files.demoEditor)))
check('app image-editor 去手写按钮 action=erase_v2',
  /\{ action: 'erase_v2', label: '去手写'/.test(read(files.appEditor)))
check('demo recognize 去手写(paper/题/答) 均指向 erase_v2',
  ['openEditorWithAction(\'paper\', \'erase_v2\')',
   'openEditorWithAction(\'question\', \'erase_v2\')',
   'openEditorWithAction(\'answer\', \'erase_v2\')'].every((s) => read(files.demoRecognize).includes(s)))
check('app recognize 去手写(paper/题/答) 均指向 erase_v2',
  ['openEditorWithAction(\'paper\', \'erase_v2\')',
   'openEditorWithAction(\'question\', \'erase_v2\')',
   'openEditorWithAction(\'answer\', \'erase_v2\')'].every((s) => read(files.appRecognize).includes(s)))

console.log('\n【二、后端必须对 erase_v2 路由到 eraseV2（否则前端白改）】')
check('image.controller 对 erase_v2 走 eraseV2()',
  /dto\.action === 'erase_v2'[\s\S]*?this\.imageService\.eraseV2/.test(read(files.imgController)))

console.log('\n【三、process() 不能因「模型返回 base64」而系统性失效】')
const svc = read(files.imgService)
check('generate 显式要求 responseFormat: \'url\'', /responseFormat: 'url'/.test(svc))
check('有 base64 兜底（不再只依赖 imageUrls）',
  /resultUrl[\s\S]*?else\s*\{[\s\S]*?b64_json[\s\S]*?Buffer\.from\(b64, 'base64'\)/.test(svc))
check('URL 缺失且无 b64 才抛「未返回图片」',
  /throw new BadRequestException\('处理服务未返回图片'\)/.test(svc))

console.log('\n【四、拉取结果图需安全透传同域鉴权头（防 403）】')
check('download 接受并透传 forwardHeaders',
  /download\(url[^)]*forwardHeaders/.test(svc))
check('仅对 Coze/字节系域名透传（防令牌泄露）',
  /SAFE_FORWARD_HOSTS[\s\S]*?allowForwardHeaders/.test(svc) &&
  /coze|volcengine|byteimg|bytedance/.test(svc))

console.log('\n【五、反向证伪：不能回退成「三功能全走图生图重绘」】')
check('process() 仍只服务 auto/enhance/erase（图生图）',
  /PROMPTS\[action\][\s\S]*?action 仅支持 auto \/ enhance \/ erase/.test(svc))
check('去手写不再走 PROMPTS 的图生图 erase 重绘（前端已切 erase_v2）',
  !/\{ action: 'erase', label: '去手写'/.test(read(files.demoEditor) + read(files.appEditor)))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：', fails.join(' | '))
  process.exit(1)
}
console.log('✅ 去手写/自动调正/智能高清 可用性修复一致性断言全部通过')
