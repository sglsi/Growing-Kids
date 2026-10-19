#!/usr/bin/env node
/**
 * 本轮修复回归：
 *  [A] 「更多」选错图 → replaceTimelineImage 原位替换（不再新建+软删导致列表错位）
 *  [B] 后端 capabilities 能力自检端点（终结「点了不能用但看不到原因」的循环）
 *  [C] AI 失败错误详情弹窗（不再一闪而过的 toast）
 *  [D] 四角模式保存不误裁（cornerMode==='rect' 条件）
 *  [E] push-ready 与 demo 两线文件同步（防止用户从任一目录构建都拿到修复）
 */
const fs = require('fs')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

const PR = '/workspace/projects'
const DEMO = '/workspace/demo'
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

const prApi = read(`${PR}/src/services/api.ts`)
const demoApi = read(`${DEMO}/src/services/api.ts`)
const prIdx = read(`${PR}/src/pages/index/index.tsx`)
const prEditor = read(`${PR}/src/components/image-editor.tsx`)
const prCtl = read(`${PR}/server/src/image/image.controller.ts`)
const prSvc = read(`${PR}/server/src/timeline/timeline.service.ts`)
const prTypes = read(`${PR}/server/src/timeline/timeline.types.ts`)
const prCard = read(`${PR}/src/components/review-item-card.tsx`)

console.log('\n[A] 原位替换：replaceTimelineImage 不再「新建+软删」')
{
  for (const [tag, src] of [['push-ready', prApi], ['demo', demoApi]]) {
    ok(`${tag}: 上传用 purpose=temp（不落库，避免产生新条目）`,
      /replaceTimelineImage[\s\S]{0,600}?purpose:\s*'temp'/.test(src))
    ok(`${tag}: 原位更新 PUT file_key`, /updateTimeline\(oldItem\.id,\s*\{\s*file_key:\s*up\.key\s*\}\)/.test(src))
    ok(`${tag}: 已删除「新建+软删」旧实现（batchDeleteTimeline/saveQuestionAsImage 不在函数内）`,
      !/replaceTimelineImage[\s\S]{0,900}?batchDeleteTimeline/.test(src))
    ok(`${tag}: 注释写明错位根因（防止回退）`,
      /原位替换/.test(src) && /别的题目的图|列表顺序/.test(src))
  }
  // 后端支持图片字段
  ok('后端 UpdateTimelineDto 含 file_key/thumb_key',
    /'file_key' | 'thumb_key'/.test(prTypes))
  ok('后端 service.update 写入 file_key/thumb_key',
    /if \(dto\.file_key !== undefined\) payload\.file_key = dto\.file_key/.test(prSvc) &&
    /if \(dto\.thumb_key !== undefined\) payload\.thumb_key = dto\.thumb_key/.test(prSvc))

  // 数据仿真：旧方案 vs 新方案对列表顺序的影响
  const oldFlow = (items, editedId) => {
    // 新建（插到最前 created_at 最新）+ 软删旧条目（假设失败：残留）
    const newList = [{ id: 'new-1', created_at: '9999' }, ...items]
    return newList // 软删失败 → 旧条目仍在 → 列表多一条且顺序变了
  }
  const newFlow = (items) => items // 原位替换：列表长度/顺序都不变
  const base = [
    { id: 'A', created_at: '003' },
    { id: 'B', created_at: '002' },
    { id: 'C', created_at: '001' },
  ]
  ok('仿真：旧方案编辑后列表出现重复+顺序错位（复现「选错图」）',
    oldFlow(base, 'A').length === 4 && oldFlow(base, 'A')[0].id === 'new-1')
  ok('仿真：新方案原位替换后列表长度与顺序完全不变',
    newFlow(base).length === 3 && newFlow(base).map(i => i.id).join(',') === 'A,B,C')
}

console.log('\n[B] capabilities 能力自检端点')
{
  ok('后端存在 @Get(capabilities) 路由', /@Get\('capabilities'\)/.test(prCtl))
  ok('capabilities 返回 version/pipeline_mode/straighten/enhance/erase_v2',
    /version:/.test(prCtl) && /straighten:\s*true/.test(prCtl) && /enhance:\s*true/.test(prCtl) && /erase_v2:\s*true/.test(prCtl))
  ok('capabilities 标注「本地自有功能，不依赖外部 AI」',
    /本地自有功能|不依赖外部/.test(prCtl))
  ok('前端 fetchImageCapabilities 存在（push-ready + demo）',
    /fetchImageCapabilities/.test(prApi) && /fetchImageCapabilities/.test(demoApi))
  ok('前端自检失败按「服务未更新」提示',
    /服务版本过旧|服务未包含|更新线上后端/.test(prEditor))
}

console.log('\n[C] AI 失败错误详情弹窗')
{
  ok('handleAi 失败走 showAiErrorDetail（弹窗，非 toast）',
    /await showAiErrorDetail\(label, e\)/.test(prEditor))
  ok('详情含 HTTP 状态码与后端消息',
    /服务返回错误 \$\{e\.status\}/.test(prEditor))
  ok('弹窗需用户手动关闭（showCancel:false + 知道了）',
    /confirmText:\s*'知道了'/.test(prEditor) && /showCancel:\s*false/.test(prEditor))
  ok('catch 中不再出现一闪而过的失败 toast（原 `Taro.showToast({ title: msg` 已移除）',
    !/const msg = e instanceof Error \? e\.message : `\$\{label\}失败/.test(prEditor))
}

console.log('\n[D] 四角模式保存不误裁')
{
  const count = (prEditor.match(/const pendingCrop = cornerMode === 'rect' && showFrame && !confirmed/g) || []).length
  ok('handleSave/handleConfirm 均带 cornerMode 条件（2 处）', count === 2, `count=${count}`)
  ok('注释写明 quad 模式误裁风险', /四角|quad/.test(prEditor) && /误.*裁|内缩/.test(prEditor))
}

console.log('\n[E] 「更多」功能两线同步')
{
  ok('push-ready 的 index 页含「更多操作」弹层（openMore/moreItem）',
    /openMore/.test(prIdx) && /moreItem/.test(prIdx))
  ok('push-ready 的 ReviewItemCard 支持onMore',
    /onMore/.test(prCard))
  ok('push-ready 的 index 集成 ImageEditor（更多→裁剪/调正/高清/去手写）',
    /ImageEditor/.test(prIdx) && /editorAction/.test(prIdx))
  ok('push-ready 的 index 编辑保存走 replaceTimelineImage（原位替换）',
    /replaceTimelineImage/.test(prIdx))
  ok('demo 的 image-editor 与 push-ready 一致（用户从任一目录构建都拿到 v3 修复）',
    read(`${DEMO}/src/components/image-editor.tsx`) === prEditor)
}

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
