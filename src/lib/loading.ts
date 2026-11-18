import Taro from '@tarojs/taro'

/**
 * 静默关闭 loading（思傅 2026-11-18，D-086）。
 *
 * 真机日志：`(in promise) MiniProgramError {"errMsg":"hideLoading:fail:toast can't be found"}`
 *
 * 根因（微信平台行为，不是业务逻辑错）：
 * `showToast` 与 `showLoading` 在微信里共用**同一个提示实例**——一旦弹过 toast，
 * 原来的 loading 就被顶掉了；此后再调 `hideLoading()` 找不到那个实例，返回的
 * Promise 被 reject。裸调用没 `.catch()` ⇒ 变成 unhandled rejection，真机调试器
 * 红字报错，用户会以为功能坏了。
 *
 * 处理方式：
 *  - 统一走本函数，把「已经没 loading 了」当作正常情况吞掉；
 *  - 需要弹 toast 的地方，**先** hideLoadingSafe() **再** showToast，
 *    否则 toast 会被随后的 hideLoading 抢关（P-016/D-019 踩过）。
 *
 * ⚠️ 只吞 hideLoading 的失败，不包 showLoading / 业务异常——真错误不许静默。
 */
export function hideLoadingSafe(): void {
  try {
    // Taro 的类型声明里 hideLoading 返回 Promise，个别平台可能返回 undefined
    const ret = Taro.hideLoading() as unknown as { catch?: (fn: () => void) => void } | undefined
    if (ret && typeof ret.catch === 'function') ret.catch(() => { /* toast 顶掉了 loading，正常 */ })
  } catch {
    /* 未显示过 loading：忽略 */
  }
}
