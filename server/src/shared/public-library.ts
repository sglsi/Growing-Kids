/**
 * P-011 / D-014 · 公共资料库的固定归属账号。
 *
 * ## 为什么是「固定 owner」而不是「去掉 user_id」
 * 生产库没有 RLS，隔离 100% 依赖代码层 `.eq('user_id', …)`（`check-isolation`
 * 静态门禁逐点扫描）。新建一张无 `user_id` 的公共表要搬 457MB 派生数据、
 * 双写、改全部取数口，且会给门禁开一个「这张表不用过滤」的例外口子。
 *
 * 方案 A：**保留 `user_id` 列**，公共资料的读写统一用本文件的常量 owner。
 * 于是：
 *   - 门禁仍看得见 `.eq('user_id', …)`，不需要任何白名单/豁免注释；
 *   - 公共资料与私有资料在同一张表里按 owner 天然区分，零数据搬迁；
 *   - 回滚只需把 owner 换回登录用户（或 `NETDISK_TEXT_RECALL=0` 关召回）。
 *
 * ## 🔴 红线
 * 这个 owner **绝不能接收 `userId`**，也绝不能由请求参数决定。
 * 「公共题库无条件开放」＝任何登录用户查到的是同一批运营者提供的资料；
 * 「私有绝对私有」＝用户自己的 `library_docs` / 错题 / 缓存仍按各自 userId。
 * M33 有静态断言钉死这两条。
 *
 * ## 归属口径（2026-11-07 L3 体检）
 * 现网 326,680 个题目对象与 78,430 条网盘索引只挂在 2 个账号下：
 * 正式号 `cc6d7b10…`(admin) 与联调探测号 `f158a819…`。
 * 生产数据归户（把探测号的行并到正式号）是**独立的写生产动作**，
 * 须单独拍板，见 `P-011` 实施清单第 9 项；本文件不负责改数据。
 */
import { normalizeForMatch } from './question-match'

/** 生产库运营者正式账号（L3 2026-11-07 实测） */
export const DEFAULT_PUBLIC_LIBRARY_OWNER_ID = 'cc6d7b10-a5dd-4a1a-8ace-5c5e94bf1307'

/**
 * 公共资料归属账号。
 * 环境变量仅用于**本地开发库 / 灾备切换**，不接受请求参数。
 */
export function publicLibraryOwner(): string {
  const fromEnv = (process.env.PUBLIC_LIBRARY_OWNER_ID || '').trim()
  return fromEnv || DEFAULT_PUBLIC_LIBRARY_OWNER_ID
}

/**
 * P2 正文归一化：`text_flat` 的唯一真相源。
 *
 * 🔴 必须与 `question-match.ts` 的 `normalizeForMatch()` 逐字一致
 *    （只留汉字 / 字母 / 数字，去掉全部标点与空白），否则 keys 与正文对不上，
 *    正是 P-008 实测「正文 0 命中」的根因。
 * 回填脚本、运行时缓存写入、检索 keys 三处都走这里，不许各自实现正则。
 *
 * 🔴 PG `text` 不接受 U+0000：先剥 NUL 再归一化（教训 L：夹 NUL 整条
 *    update 抛 0x00，会伪装成环境失败）。
 */
export function flatText(s: string): string {
  return normalizeForMatch((s || '').replace(/\u0000/g, ''))
}

/**
 * P2 正文召回开关（一键回退到纯文件名召回）。
 * 默认开启；线上若出现性能/误判异常，设 `NETDISK_TEXT_RECALL=0` 立即退回，
 * 不需要回滚代码。P3 的 `MAX_DEEP_FILES` 放宽仍另案、不受此开关影响。
 */
export function textRecallEnabled(): boolean {
  return process.env.NETDISK_TEXT_RECALL !== '0'
}
