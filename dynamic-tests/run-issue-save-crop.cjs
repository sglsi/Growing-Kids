/**
 * 问题 1 真根因回归：「旋转预览正常，但保存后被裁」。
 *
 * 真根因（此前多轮误判为 canvas 尺寸问题，实际在保存链路的状态机）：
 *   旋转 / AI 处理后，代码把 crop 重置为 DEFAULT_CROP（内缩 5%~8%），
 *   并置 confirmed=false、framing=false；而旧的 handleSave 用
 *     `confirmed ? currentSrc : await exportEdited()`
 *   判断 → confirmed=false ⇒ 走 exportEdited() ⇒ 按 crop（=内缩的 DEFAULT_CROP）再裁一刀 ⇒ 四周被裁。
 *
 * 修复：
 *   - handleSave 与 handleConfirm 统一用 `pendingCrop = showFrame && !confirmed`，
 *     只有「主动裁剪且未确认」才按框裁；否则直接用 currentSrc（成品）；
 *   - 旋转 / AI 后置 confirmed=true（结果即成品），语义自洽。
 *
 * 本测试用**状态机仿真**（复刻组件状态流转）验证：各种操作路径下，
 * 「保存」是否错误地按 crop 二次裁剪。
 */
const fs = require('fs')
const FE = '/workspace/projects/src/components/image-editor.tsx'
const src = fs.readFileSync(FE, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

// ── 从源码提取关键常量与判断式，保证测试与实现不脱节 ──
const defaultCrop = src.match(/const DEFAULT_CROP[^=]*=\s*\{([^}]*)\}/)
const DEFAULT_CROP = eval('({' + defaultCrop[1] + '})')
const isInsetCrop = DEFAULT_CROP.x > 0 || DEFAULT_CROP.y > 0 || DEFAULT_CROP.w < 1 || DEFAULT_CROP.h < 1

console.log('==== 问题 1 真根因：保存链路状态机 ====\n')

console.log('[0] 前提事实：DEFAULT_CROP 是「内缩框」（用它裁会掉边）')
{
  console.log(`    DEFAULT_CROP = ${JSON.stringify(DEFAULT_CROP)}`)
  ok('DEFAULT_CROP 内缩（x>0 或 y>0 或 w<1 或 h<1）→ 用它裁就会裁掉四周',
    isInsetCrop, JSON.stringify(DEFAULT_CROP))
  const lostPct = Math.round((1 - DEFAULT_CROP.w) * 100)
  console.log(`    → 用它裁会掉掉左右各约 ${Math.round(DEFAULT_CROP.x * 100)}%，宽度损失 ${lostPct}%`)
}

console.log('\n[1] 复刻保存判断：pendingCrop = showFrame && !confirmed')
{
  // 复刻组件里的两个派生量
  const showFrameOf = (framing, aiBusy) => framing && !aiBusy
  const pendingCropOf = (framing, aiBusy, confirmed) => showFrameOf(framing, aiBusy) && !confirmed

  // 场景：旋转之后的状态（修复后：confirmed=true, framing=false）
  {
    const framing = false, aiBusy = false, confirmed = true
    const pendingCrop = pendingCropOf(framing, aiBusy, confirmed)
    ok('旋转后（confirmed=true, framing=false）→ 不按 crop 裁（直接存成品）', pendingCrop === false,
      `pendingCrop=${pendingCrop}`)
  }
  // 场景：AI 之后的状态（修复后：confirmed=true, framing=false）
  {
    const framing = false, aiBusy = false, confirmed = true
    ok('AI 后（confirmed=true, framing=false）→ 不按 crop 裁', pendingCropOf(framing, aiBusy, confirmed) === false)
  }
  // 场景：用户主动进入裁剪、尚未确认（应裁剪）
  {
    const framing = true, aiBusy = false, confirmed = false
    ok('用户主动裁剪未确认（framing=true, confirmed=false）→ 按 crop 裁（符合预期）',
      pendingCropOf(framing, aiBusy, confirmed) === true)
  }
  // 场景：用户已确认裁剪（不再裁）
  {
    const framing = true, aiBusy = false, confirmed = true
    ok('已确认裁剪（confirmed=true）→ 不重复裁', pendingCropOf(framing, aiBusy, confirmed) === false)
  }
  // 场景：AI 处理中
  {
    ok('AI 处理中（aiBusy=true）→ showFrame=false → 不裁',
      pendingCropOf(true, true, false) === false)
  }
}

console.log('\n[2] 反例：旧 handleSave 判断 `confirmed ? currentSrc : exportEdited()`（会裁）')
{
  // 旧式判断：confirmed=false ⇒ 走 exportEdited ⇒ 按 crop 裁
  const oldPending = (confirmed) => !confirmed
  // 旧代码在旋转后设 confirmed=false（错误）→ 保存必然走裁剪分支
  ok('旧实现：旋转后 confirmed=false ⇒ 保存走 exportEdited（按内缩 crop 裁）',
    oldPending(false) === true)
  // 若此时 crop 恰为 DEFAULT_CROP → 真的掉边
  const cropAtSave = DEFAULT_CROP
  const clipLeftPct = Math.round(cropAtSave.x * 100)
  const clipTopPct = Math.round(cropAtSave.y * 100)
  ok(`旧实现：保存时 crop=DEFAULT_CROP，左右各裁 ${clipLeftPct}%、上下各裁 ${clipTopPct}% ⇒ 四周被裁`,
    clipLeftPct > 0 && clipTopPct > 0)
}

console.log('\n[3] 源码一致性（修复落地检查）')
{
  // handleSave 必须用统一判断
  const saveBlock = src.slice(src.indexOf('const handleSave = async'), src.indexOf('const handleConfirm = async'))
  ok('handleSave 使用 pendingCrop = showFrame && !confirmed',
    /const pendingCrop = showFrame && !confirmed/.test(saveBlock))
  ok('handleSave 在非 pendingCrop 时直接用 currentSrc（本地化），不再无条件 exportEdited',
    /pendingCrop \? await exportEdited\(\) : await toLocalIfRemote\(currentSrc\)/.test(saveBlock))
  ok('handleSave 不再出现「confirmed ? currentSrc : await exportEdited()」旧写法',
    !/confirmed \? currentSrc : await exportEdited\(\)/.test(src))

  // 旋转后必须 confirmed=true
  const rotBlock = src.slice(src.indexOf('const handleRotate = async'), src.indexOf('const handleReset ='))
  ok('handleRotate 旋转后置 confirmed=true（结果即成品）', /setConfirmed\(true\)/.test(rotBlock))
  ok('handleRotate 不再置 confirmed=false', !/setConfirmed\(false\)/.test(rotBlock))

  // AI 后必须 confirmed=true
  const aiTail = src.slice(src.indexOf('setCurrentSrc(dl.tempFilePath)'), src.indexOf('Taro.showToast({ title: `${label}完成`'))
  ok('AI 成功后置 confirmed=true', /setConfirmed\(true\)/.test(aiTail))

  // 两处判断必须一致（防止再次只改一处）
  const count = (src.match(/const pendingCrop = showFrame && !confirmed/g) || []).length
  ok('handleSave 与 handleConfirm 共用同一判断（出现 2 处）', count === 2, `count=${count}`)
}

console.log(`\n==== 结果：${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
