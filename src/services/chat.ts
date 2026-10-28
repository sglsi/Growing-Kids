// ============================================================
// 通用对话（扣子 LLM，经后端代理）——区别于智能客服 /api/chat/message
//
// 安全：PAT 只存后端 server/.env.secrets；前端只打自己的后端域名，
//       绝不直连 api.coze.cn（否则令牌会被打进小程序包、被反编译扒走）。
// ============================================================
import { Network } from '@/network'
import { buildHeaders, captureUserId } from '@/services/net'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 发一条消息给通用 AI 助手，返回回答文本。
 * @param message 本轮用户输入
 * @param history 多轮上下文（可选，按时间正序；由调用方维护）
 */
export async function sendChat(message: string, history: ChatTurn[] = []): Promise<string> {
  const res = await Network.request({
    url: '/api/chat',
    method: 'POST',
    data: { message, history },
    header: buildHeaders({ 'Content-Type': 'application/json' }),
    // ⚠️ 扣子非流式轮询实测 ~90s，但微信 request **超时上限 60s**，
    //    写 130000 不会生效 ⇒ 慢回答在小程序端会被掐断（表现为「发送失败」）。
    //    未修：需后端改流式（SSE/分包返回）或异步 ticket，见 OPS-18 R-上线-01。
    timeout: 130000,
  })
  captureUserId(res)
  const body = res.data as { code?: number; msg?: string; data?: { answer?: string } }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(body?.msg || `对话请求失败(${res.statusCode})`)
  }
  if (body?.code !== undefined && body.code !== 200) {
    throw new Error(body.msg || '对话失败')
  }
  return body?.data?.answer || ''
}
