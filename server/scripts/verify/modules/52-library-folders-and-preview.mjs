// 模块 52：资料库「直接拖动 / 预览放大旋转裁剪 / 无限层级文件夹」（D-068 / P-030）
//
// 🔴 本模块只守静态契约，不连数据库、不连微信、不碰判定层。
//    「真机手势能不能拖」「Canvas 旋转在真机上是否出图」必须由实机回归证明，
//    静态守卫不得被当作已验证的证据。
//
// 思傅 11-15 四项拍板：
//  ① 长按当前能激活但拖不动 ⇒ 缺陷修复（调整到能够拖动），不是交互改判；
//  ② 放大仅查看不写回，旋转/裁剪写回并参与合成；
//  ③ 通用 image-editor 与合成页预览「两处都加」左转 90°；
//  ④ 文件夹用无限层级树。

import fs from 'fs'
import path from 'path'
import { Module } from '../lib/harness.mjs'

const m = new Module('M52', '资料库直接拖动 / 预览编辑 / 无限层级文件夹（D-068）')
const ROOT = path.resolve(process.cwd(), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = (f) => fs.existsSync(path.join(ROOT, f))

const MIG = 'migrations/0033_library_folders.sql'
const FSVC = 'server/src/library/library-folder.service.ts'
const FCTRL = 'server/src/library/library-folder.controller.ts'
const LSVC = 'server/src/library/library.service.ts'
const LCTRL = 'server/src/library/library.controller.ts'
const LMOD = 'server/src/library/library.module.ts'
const COMB = 'server/src/library/library-image-combine.service.ts'
const UPLOAD = 'server/src/upload/upload.controller.ts'
const API = 'src/services/api.ts'
const FE = 'src/pages/library/index.tsx'
const EDITOR = 'src/components/image-editor.tsx'
const ROT = 'src/lib/rotate-image.ts'
const E2E = 'dynamic-tests/run-library-d068.cjs'

m.test('A1 无限层级 schema 与软删字段齐备', (c) => {
  c.ok(exists(MIG), '0033 migration 缺失')
  const s = read(MIG)
  c.ok(/create table if not exists library_folders/.test(s), '须建 library_folders 表')
  c.ok(/parent_id\s+varchar\(36\)\s+references library_folders\(id\)/.test(s), 'parent_id 必须自引用（无限层级）')
  c.ok(/add column if not exists folder_id/.test(s), 'library_docs 须加 folder_id')
  c.ok(s.includes('deleted_at'), '文件夹须可软删（不真删资料）')
  c.ok(/create index if not exists/.test(s), 'parent_id / folder_id 须建索引')
})

m.test('A2 文件夹服务：用户隔离 / UGC 守卫 / 防成环 / 软删提升', (c) => {
  c.ok(exists(FSVC), 'library-folder.service.ts 缺失')
  const s = read(FSVC)
  // 本库无 RLS，每条链都要带 user_id；用计数兜底防「新增一条查询忘了隔离」
  const froms = (s.match(/\.from\(/g) || []).length
  const eqUser = (s.match(/\.eq\('user_id', userId\)/g) || []).length
  c.ok(froms > 0 && eqUser >= froms, `每条查询链都要 .eq('user_id', userId)（from=${froms}, eq=${eqUser}）`)
  c.ok(s.includes('assertAllowed') && s.includes("tag: 'library_folder.create'"), '新建须过 UgcTextGuard')
  c.ok(s.includes("tag: 'library_folder.rename'"), '改名须过 UgcTextGuard')
  c.ok(s.includes('MAX_DEPTH') && s.includes('不能把文件夹放到它自己的子目录下'), '移动须做循环引用检查')
  c.ok(s.includes('deleted_at: new Date().toISOString()'), '删除必须是软删')
  c.ok(s.includes('promoted_docs') && s.includes('promoted_folders'), '软删须把资料与子文件夹提升到父级')
  c.ok(!/\.delete\(\)/.test(s), '⛔ 不得硬删任何行（资料绝不因删文件夹而丢失）')
})

m.test('A3 老库 fail-safe：不显式传 folder_id 就不碰新列', (c) => {
  const s = read(LSVC)
  c.ok(/const raw = \(query\.folder_id \?\? ''\)\.trim\(\)/.test(s), '列表过滤须以「显式传入」为前提')
  c.ok(s.includes('__root__') && s.includes(".is('folder_id', null)"), "'root' 须解释为未归类")
  c.ok(s.includes('...(folderId ? { folder_id: folderId } : {})'), 'create 只在拿到合法 folderId 时才写新列')
  c.ok(s.includes('if (patch.folder_id !== undefined)'), 'update 只在显式传了 folder_id 时才写新列')
  c.ok(s.includes('this.folders.assertFolder'), '写入前须校验目标文件夹归属本人')
  const f = read(FSVC)
  c.ok(f.includes("v && v !== 'root' ? v : null"), "'root'/空串必须归一为 NULL，不入库当外键")
})

m.test('A4 路由与模块注册（不被 :id 吃掉 / 要求登录）', (c) => {
  const ctrl = read(FCTRL)
  const mod = read(LMOD)
  c.ok(ctrl.includes("@Controller('library/folders')"), '文件夹须挂独立前缀（避免被 :id 抢路由）')
  const reqs = (ctrl.match(/requireUserId\(req\)/g) || []).length
  c.ok(reqs >= 4, `4 个端点都须 requireUserId（实得 ${reqs}）`)
  // 控制器源码里有「不进 PUBLIC_ROUTES」的注释，不能拿注释当判据 ⇒ 查清单真相源
  c.ok(!read('server/src/shared/user-context.ts').includes('library/folders'), '不得登记进免登录路由清单')
  c.ok(mod.includes('LibraryFolderController') && mod.includes('LibraryFolderService'), 'module 须注册 controller + service')
  c.ok(mod.includes('SecurityModule'), 'UgcTextGuard 依赖 SecurityModule')
  const lc = read(LCTRL)
  c.ok(lc.includes("@Query('folder_id') folderId?: string"), '列表须接收 folder_id')
  c.ok(lc.includes("'combine-images'"), '合成端点仍在')
})

m.test('A5 上传 / 合成归档到当前文件夹（不丢页序）', (c) => {
  const up = read(UPLOAD)
  const cb = read(COMB)
  const api = read(API)
  c.ok(/b\.folder_id \?\? q\.folder_id/.test(up), '上传须从 query + formData 双读 folder_id')
  c.ok((up.match(/folder_id: folderId,/g) || []).length >= 2, '图片与文档两条归档链都要透传')
  c.ok(/combine\(userId: string, keys: string\[\], name\?: string, folderId\?: string \| null\)/.test(cb), 'combine 须接收 folderId')
  c.ok(!/\.sort\(/.test(cb) && !cb.includes('Promise.all'), '⛔ 不得因目录改动重排或并行拉取图片')
  c.ok(api.includes('combineLibraryImages(keys: string[], name: string, folderId?: string)'), '前端 API 须支持第三个参数')
  c.ok(api.includes('fetchLibraryFolders') && api.includes('moveLibraryDocToFolder'), '文件夹 CRUD / 移动资料封装须齐')
})

m.test('A6 前端能力探测 + 缓存 key 带目录（旧后端不打挂）', (c) => {
  c.ok(exists(FE), 'library/index.tsx 缺失')
  const s = read(FE)
  c.ok(s.includes('folderSupportedRef') && s.includes('fetchLibraryFolders()'), '须先探测文件夹能力')
  c.ok(s.includes('folderSupportedRef.current = false'), '探测失败须关掉文件夹能力')
  c.ok(/folderQuery = \(\)/.test(s) && s.includes('ROOT_FOLDER'), '目录查询须有统一入口')
  c.ok(s.includes('folderId: fid ||'), '缓存 key 必须带当前目录')
  c.ok(s.includes('folderId: fid,'), 'fetchLibrary 须传 folder_id')
  c.ok(s.includes('folderId: folderQuery()'), '上传须传当前目录')
  c.ok(s.includes('combineLibraryImages(keys, composeName.trim() || genCombineName(), folderQuery())'), '合成须传当前目录')
})

m.test('A7 无限层级目录纯函数与移动防成环', (c) => {
  const s = read(FE)
  for (const fn of ['folderPathOf', 'subtreeIds', 'folderTreeRows']) {
    c.ok(s.includes(`function ${fn}`), `须有纯函数 ${fn}`)
  }
  c.ok(s.includes('folderTreeRows(folders, folderPicker.kind === \'folder\' ? folderPicker.id : null)'), '移动文件夹须排除自身子树')
  c.ok(s.includes("'重命名', '移动到…', '删除文件夹'"), '文件夹须可改名 / 移动 / 删除')
  c.ok(s.includes('删除文件夹') && s.includes('不会删除文件'), '删除确认须说清「资料不丢」')
})

m.test('A8 直接拖动修复：提前量矩形 / 多祖先收事件 / 去重复 / 跟手反馈', (c) => {
  const s = read(FE)
  c.ok(s.includes('measureCells'), '须有独立的矩形测量函数')
  c.ok(s.includes('onTouchStart={() => { measureCells() }}'), 'touchstart 就提前量矩形（旧实现只在长按回调里量）')
  c.ok(s.includes('dragActiveRef'), '须用 ref 记活跃态，防多祖先重复 touchend 造成重复落位')
  c.ok(s.includes('clientX') && s.includes('pageX'), '须兼容两种坐标字段口径')
  c.ok(s.includes('function hitCellIndex'), '落点命中须是可离线执行的纯函数')
  c.ok(s.includes('span * 1.6'), '须有「最近格子」兜底（拖到格子间隙也有落点）')
  c.ok(s.includes('dragging && dragPoint'), '拖动须有跟手浮层（可见反馈）')
  c.ok(s.includes('scrollY={!dragging}'), '拖拽期间仍须锁住页面滚动（M51 A9 不回退）')
  c.ok(s.includes('longPressAtRef'), '长按后的 tap 吞掉须有时间窗，不能把下一次点击也吞掉')
})

m.test('A9 预览编辑：放大只看 / 左右转写回 / 裁剪写回 / 左转两处都加', (c) => {
  const s = read(FE)
  const ed = read(EDITOR)
  const rot = read(ROT)
  c.ok(s.includes('放大仅查看；旋转 / 裁剪会写入合成结果'), '须明示「放大不写回」口径')
  c.ok(s.includes('setComposeImage(idx, out)') && s.includes('setComposeImage(idx, path)'), '旋转与裁剪结果都须写回')
  c.ok(s.includes("label=\"左转90°\"") && s.includes("label=\"右转90°\""), '合成页预览须有左转 + 右转')
  c.ok(s.includes('cropOnly') && s.includes('enableSaveToInbox={false}'), '裁剪须复用通用编辑器且只回传不落库')
  c.ok(s.includes('Taro.previewImage'), '放大须走原生预览（双指缩放，只看）')
  c.ok(ed.includes('RotateCcw') && ed.includes('handleRotate(-1)'), '通用编辑器须加左转 90°')
  c.ok(ed.includes('(rotation + dir * 90 + 360) % 360'), '左转须用 (rotation - 90 + 360)%360 等价式，不另起角度体系')
  c.ok(rot.includes('const deg = dir === 1 ? 90 : 270'), '合成页左转须复用顺时针 270° 分支')
  c.ok(rot.includes('waitCanvasCss') && rot.includes('destWidth: outW'), '旋转烘焙须沿用 CSS/缓冲 1:1 + 全区域导出')
})

m.test('A10 离线实证脚本存在', (c) => {
  c.ok(exists(E2E), 'run-library-d068.cjs 缺失')
  const s = read(E2E)
  for (const kw of ['folderPathOf', 'subtreeIds', 'folderTreeRows', 'hitCellIndex', '无限层级', '写回', '放大']) {
    c.ok(s.includes(kw), `实证脚本缺少 ${kw} 用例`)
  }
})

export default m
