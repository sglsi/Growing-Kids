import Taro from '@tarojs/taro'
import { POLICY_CONSENT_STORAGE_KEY, PRIVACY_POLICY_VERSION } from '@/constants/privacy-policy'

/**
 * 业务级隐私政策同意闸门（GK-23-24）。
 *
 * ## 与另外两个「隐私」的分工，别混
 * - `services/net` 的令牌 / `utils/privacy` 的 `guardPrivacy`：**平台级**授权，
 *   管的是「基础库允不允许调 chooseMedia 这类接口」（拒绝会 errno 112）。
 * - `components/policy-consent`：**业务级**同意，管的是「监护人是否同意我们处理
 *   孩子的学习内容」。首次启动弹一次，可点「稍后」，不锁死浏览。
 * - 本文件：把上面那份同意**真正接进写操作**。
 *
 * ## 为什么必须有这一段
 * `policy-consent` 的注释一直写着「涉及上传/写入的操作仍需先同意」，但代码里
 * **从来没有一处检查过** —— 点「稍后」之后，用户可以一路拍照、上传、入库，
 * 等于首屏那次征求同意只是个装饰。数据主体是未成年人，这是**合规硬缺口**，
 * 不是体验问题（GK-QA-23 §6.2 GK-23-24）。
 *
 * ## 交互取舍
 * 未同意时**不静默失败**，也不偷偷放行：弹一次说明 → 用户点「去同意」→
 * 唤起政策弹层。用户同意后回到原页面再点一次按钮（不自动重放：让「同意」
 * 始终是他明确做出的动作，而不是被一次点击挟带出来）。
 */

type PolicyListener = (need: boolean) => void

/** 需要「重新弹出同意层」时通知 policy-consent 组件（全站单例，Set 足够） */
const subscribers = new Set<PolicyListener>()

/** 是否已同意**当前版本**的政策（版本号变了等于没同意，见 constants 头部规则） */
export function hasAgreedPolicy(): boolean {
  try {
    return Taro.getStorageSync(POLICY_CONSENT_STORAGE_KEY) === PRIVACY_POLICY_VERSION
  } catch (e) {
    // 读存储失败按「未同意」处理（fail-closed），但必须留痕
    console.warn('[policy-gate] 读取同意状态失败，按未同意处理', e)
    return false
  }
}

/** 记录「已同意当前版本」；写入失败必须报出来，否则下次还会被拦（用户会觉得按钮失灵） */
export function markPolicyAgreed(): boolean {
  try {
    Taro.setStorageSync(POLICY_CONSENT_STORAGE_KEY, PRIVACY_POLICY_VERSION)
    return true
  } catch (e) {
    console.error('[policy-gate] 写入同意状态失败', e)
    return false
  }
}

/** 请求弹出业务隐私政策同意层（由 policy-consent 组件订阅） */
export function requestPolicyConsent(): void {
  subscribers.forEach((fn) => fn(true))
}

/** 订阅「需要同意」事件，返回取消订阅函数 */
export function onPolicyConsentRequest(fn: PolicyListener): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/**
 * 写操作/内容上传前的统一闸门。返回 true 才继续，false 时已给出用户可读提示。
 *
 * 用法与 `guardPrivacy` 完全一致，二者是**串行两道**，不是二选一：
 *
 * ```ts
 * if (!(await guardPolicy('上传图片'))) return   // 监护人同意（业务）
 * if (!(await guardPrivacy('选择图片'))) return  // 平台授权（基础库）
 * ```
 *
 * @param action 动作名，用于文案，如「上传图片」「保存记忆」
 */
export async function guardPolicy(action: string): Promise<boolean> {
  if (hasAgreedPolicy()) return true
  const res = await Taro.showModal({
    title: '需先同意隐私政策',
    content: `继续${action}前，请先阅读并同意《成长学童 · 隐私政策》。我们仅在您同意后上传和处理孩子的学习内容。`,
    confirmText: '去同意',
    cancelText: '暂不',
  })
  if (res.confirm) requestPolicyConsent()
  return false
}
