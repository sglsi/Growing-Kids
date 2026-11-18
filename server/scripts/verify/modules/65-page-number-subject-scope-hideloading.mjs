// 模块 65：页码基准收口 / 答案裁剪按科目过滤 / hideLoading 报错收口（D-086）
//
// 🔴 静态契约。真机验的是：页码不重号、筛选条默认停在本科目、控制台不再报
//    `hideLoading:fail:toast can't be found`。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M65', '页码基准 / 资料按科目过滤 / hideLoading 收口（D-086）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

const API = 'src/services/api.ts'
const ANS = 'src/components/answer-editor.tsx'
const PICKER = 'src/components/material-picker.tsx'
const LOADING = 'src/lib/loading.ts'

/** 递归收集 src 下的 ts/tsx（用于「全仓不许有裸调用」这类断言） */
function walkSrc(dir = 'src', out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walkSrc(rel, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

m.test('A1 页码只有一套基准：后端 0 基 → 前端 1 基只转一次', (c) => {
  const api = read(API)
  c.ok(/index: Number\(p\.index\) \+ 1/.test(api), 'fetchDocPages 须把后端 0 基页码 +1 归一')
  // 旧写法 `p.index || i + 1` 把 0 当假值 ⇒ 第 1、2 页都显示「第 1 页」（真机可见）
  const a = read(ANS)
  c.ok(!/\|\| i \+ 1, url/.test(a), '调用点不许再用 `p.index || i + 1` 兜底（0 是假值）')
  c.ok(/pages = r\.pages\.map\(\(p\) => \(\{ index: p\.index, url: p\.url \}\)\)/.test(a),
    '页项页码须直接用归一后的 index')
  // 全仓再无「页码假值兜底」（注释里引用旧写法不算）
  const codeLines = (f) => read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  const offenders = walkSrc().filter((f) => codeLines(f).some((l) => /index \|\| i \+ 1/.test(l)))
  c.ok(offenders.length === 0, `仍有页码假值兜底：${offenders.join(', ') || '无'}`)
})

m.test('A2 答案选资料默认只看本科目，可一键切全部', (c) => {
  const p = read(PICKER)
  c.ok(/subjectId\?: string \| null/.test(p), '资料选择器须接受 subjectId')
  c.ok(/setScope\(subjectId \? 'subject' : 'all'\)/.test(p), '未归类的题目不显示筛选条（恒为全部）')
  c.ok(/scope === 'subject'/.test(p) && /fetchLibrary\(\{ pageSize: 100, subjectId:/.test(p),
    '本科目范围须走服务端 subject_id 过滤（不是前端截断）')
  c.ok(/仅\{subjectName \|\| '本科目'\}/.test(p) && /全部资料/.test(p), '须有「仅X / 全部资料」切换')
  c.ok(/visible && !prevVisibleRef\.current/.test(p), '每次打开都要回到本科目，不延续上次的「全部」')

  const a = read(ANS)
  c.ok(/subjectId=\{item\?\.subject_id \|\| null\}/.test(a), '答案编辑器须把本题科目传给资料选择器')
})

m.test('A3 hideLoading 统一走安全包装，不再裸调', (c) => {
  const lib = read(LOADING)
  c.ok(/export function hideLoadingSafe/.test(lib), '须有统一的 hideLoadingSafe')
  c.ok(/ret\.catch\(\(\) =>/.test(lib), '必须 catch 掉「toast 顶掉 loading」导致的 reject')
  const offenders = walkSrc().filter((f) => f !== LOADING && /Taro\.hideLoading\(\)/.test(read(f)))
  c.ok(offenders.length === 0, `仍有裸 Taro.hideLoading()：${offenders.join(', ') || '无'}`)
  const users = walkSrc().filter((f) => /hideLoadingSafe\(/.test(read(f)))
  c.ok(users.length >= 8, `使用点过少，疑有漏改（${users.length} 个文件）`)
})

m.test('A4 弹提示前先关 loading（否则提示被抢关）', (c) => {
  const a = read(ANS)
  c.ok(/hideLoadingSafe\(\)\n\s+\/\/ D-086：先关 loading 再弹 toast|hideLoadingSafe\(\)[\s\S]{0,160}已加入答案/.test(a),
    '加入答案成功须先关 loading 再 toast')
  // 粗断言：同一函数里不许 showToast 后紧跟 hideLoadingSafe（顺序反了会被抢关）
  const bad = /Taro\.showToast\(\{[\s\S]{0,120}?\}\)\s*\n\s*hideLoadingSafe\(\)/
  const hit = [ANS, 'src/pages/recognize/index.tsx', 'src/pages/profile/index.tsx', 'src/pages/library/index.tsx']
    .filter((f) => bad.test(read(f)))
  c.ok(hit.length === 0, `提示被抢关的写法仍在：${hit.join(', ') || '无'}`)
})

export default m
