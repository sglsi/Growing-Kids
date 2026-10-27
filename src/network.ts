import Taro from '@tarojs/taro'
import { ensureBackendAwake, isConnError } from '@/services/wake'
import { clearAuthToken, ensureAuthToken } from '@/services/auth-bootstrap'

/**
 * 网络请求模块
 * 封装 Taro.request、Taro.uploadFile、Taro.downloadFile，自动添加项目域名前缀
 * 如果请求的 url 以 http:// 或 https:// 开头，则不会添加域名前缀
 *
 * IMPORTANT: 项目已经全局注入 PROJECT_DOMAIN
 * IMPORTANT: 除非你需要添加全局参数，如给所有请求加上 header，否则不能修改此文件
 *
 * 2026-10-24 全局能力（经思傅确认）：request 遇连接类错误（后端挂了/电脑重启）
 * 时自动唤醒后端并重放一次——替代已取消的看门狗机制。详见 services/wake.ts。
 *
 * 2026-10-27 全局能力（OPS-18 R-技术-09 严格令牌化）：后端起严格令牌模式后，
 * 业务请求必须带 `X-Auth-Token`。首次启动无令牌 / 令牌过期会得到 401，这里
 * 统一换令牌并重放一次——**所有调用方都不用改**（40+ 处 Network.request 无感）。
 */
export namespace Network {
    const createUrl = (url: string): string => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return url
        }
        // 兜底：编译期 PROJECT_DOMAIN 为空（未配置 .env.local / PROJECT_DOMAIN）时，
        // H5 端保持相对路径走 devServer 代理；小程序端没有相对路径概念，
        // 必须补全为绝对地址，否则微信直接报 `request:fail invalid url "/api/..."`。
        const base = PROJECT_DOMAIN || (TARO_ENV === 'h5' ? '' : 'http://127.0.0.1:3001')
        return `${base}${url}`
    }

    export const request: typeof Taro.request = option => {
        let retried = false
        let tokenRetried = false
        // 跑一次原请求（保留 option.success/fail 回调语义，同时 promise 化）
        const run = (overrideHeaders?: Record<string, string>) =>
            new Promise<Taro.request.SuccessCallbackResult>((resolve, reject) => {
                Taro.request({
                    ...option,
                    header: overrideHeaders ? { ...(option.header as Record<string, string>), ...overrideHeaders } : option.header,
                    url: createUrl(option.url),
                    success: (res) => {
                        option.success?.(res)
                        resolve(res)
                    },
                    fail: (err) => {
                        option.fail?.(err)
                        reject(err)
                    },
                })
            })
        // 类型说明：Taro.request 的 RequestTask<T> 泛型在包装场景无法精确保持，
        // 此处收敛为 any（调用方均按 Promise<Taro.request.SuccessCallbackResult> 使用，
        // 无人使用 task.abort()——已全仓确认）。
        return (async () => {
            let res: Taro.request.SuccessCallbackResult
            try {
                res = await run()
            } catch (err) {
                // 仅连接类错误触发「唤醒→重放」；业务错误（4xx/5xx）与域名校验问题不碰
                if (retried || !isConnError(err)) throw err
                retried = true
                console.warn('[network] 连接失败，尝试唤醒后端', String((err as { errMsg?: string })?.errMsg || err))
                const ok = await ensureBackendAwake()
                if (!ok) throw err
                res = await run()
            }

            // ---- 401：换令牌后重放一次（严格令牌模式的引导） ----
            if (res.statusCode === 401 && !tokenRetried) {
                tokenRetried = true
                const reason = (res.data as { data?: { reason?: string } })?.data?.reason
                if (reason === 'TOKEN_INVALID') clearAuthToken()
                const token = await ensureAuthToken()
                if (token) {
                    console.warn('[network] 401 → 已换取身份令牌，重放请求', reason || '')
                    return run({ 'X-Auth-Token': token }) as any
                }
            }
            return res as any
        })() as any
    }

    export const uploadFile: typeof Taro.uploadFile = option => {
        return Taro.uploadFile({
            ...option,
            url: createUrl(option.url),
        })
    }

    export const downloadFile: typeof Taro.downloadFile = option => {
        return Taro.downloadFile({
            ...option,
            url: createUrl(option.url),
        })
    }
}
