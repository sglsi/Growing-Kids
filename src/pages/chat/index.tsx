import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Bot, Send, Settings2 } from 'lucide-react-taro'
import { Input } from '@/components/ui/input'
import {
  sendChatMessage,
  fetchChatHistory,
  type ChatMessage,
} from '@/services/api'
import { AI_DISABLED_HINT, ensureAiSetting } from '@/services/ai-settings'
import { BRAND, BRAND_FOREGROUND } from '@/lib/theme'

const SESSION_KEY = 'chat:session_id'
const WELCOME_TEXT =
  '您好，我是成长学童小助手，关于小程序的功能和使用问题都可以问我～'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

const initialMessages: DisplayMessage[] = [
  { id: 'welcome', role: 'assistant', content: WELCOME_TEXT },
]

/**
 * 智能客服：基于产品知识库 + LLM 的对话页面
 *  - 首次进入：展示欢迎语
 *  - 用户发送：乐观追加用户消息 + 调 /api/chat/message 拿助手回复
 *  - sessionId 用 storage 持久化，下次进入自动续接历史
 */
export default function ChatPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const sessionRef = useRef<string>('')
  const scrollRef = useRef<any>(null)

  const loadHistory = async (sid: string) => {
    if (!sid) {
      setMessages(initialMessages)
      return
    }
    setLoading(true)
    try {
      const list = await fetchChatHistory(sid)
      if (!list.length) {
        setMessages(initialMessages)
      } else {
        setMessages(
          list.map((m: ChatMessage) => ({
            id: m.id,
            role: m.role,
            content: m.content,
          })),
        )
      }
    } catch (e) {
      console.error('[chat] 加载历史失败', e)
      Taro.showToast({ title: '加载历史失败', icon: 'none' })
      setMessages(initialMessages)
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    const sid = (Taro.getStorageSync(SESSION_KEY) as string) || ''
    sessionRef.current = sid
    loadHistory(sid)
  })

  // 消息变化时滚到底部（小程序 ScrollView 提供 scrollToBottom）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        scrollRef.current?.scrollToBottom?.()
      } catch {
        /* 忽略 */
      }
    }, 60)
    return () => clearTimeout(t)
  }, [messages])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return
    // R-合规-02：智能客服会把消息发给大模型。未开启 AI 外发时先提示，别让用户白打一段字。
    if (!(await ensureAiSetting())) {
      Taro.showToast({ title: AI_DISABLED_HINT, icon: 'none' })
      return
    }
    setInput('')
    const tempUserId = `temp-u-${Date.now()}`
    setMessages((prev) => [...prev, { id: tempUserId, role: 'user', content: text }])
    setSending(true)
    try {
      const res = await sendChatMessage(sessionRef.current || null, text)
      sessionRef.current = res.session_id
      Taro.setStorageSync(SESSION_KEY, res.session_id)
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempUserId)
        return [
          ...withoutTemp,
          { id: res.user_message_id, role: 'user', content: text },
          { id: res.assistant_message_id, role: 'assistant', content: res.reply },
        ]
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '发送失败，请稍后重试'
      console.error('[chat] 发送失败', e)
      Taro.showToast({ title: msg, icon: 'none' })
      setMessages((prev) => prev.filter((m) => m.id !== tempUserId))
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const goAdmin = () => {
    Taro.navigateTo({ url: '/pages/chat/admin' })
  }

  const canSend = !!input.trim() && !sending

  return (
    <View className="bg-background" style={{ position: 'relative', height: '100vh' }}>
      {/* 固定顶部：标题 + 管理入口 */}
      <View
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          backgroundColor: '#fff',
          borderBottom: '1px solid #ecefe3',
          padding: '12px 16px 8px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Text className="block text-base font-semibold text-foreground flex-1">
          智能客服
        </Text>
        <View
          onClick={goAdmin}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '4px',
            padding: '4px 8px',
          }}
        >
          <Settings2 size={16} color="#9A948A" />
          <Text className="block text-xs text-muted-foreground">管理</Text>
        </View>
      </View>

      {/* 消息列表：留出顶部 56 + 底部 80 的内边距 */}
      <ScrollView
        ref={scrollRef}
        scrollY
        style={{ height: '100vh', paddingTop: 56, paddingBottom: 80 }}
        enhanced
        showScrollbar={false}
      >
        <View style={{ padding: '12px 16px' }}>
          {loading ? (
            <View
              className="flex items-center justify-center"
              style={{ padding: '24px 0' }}
            >
              <Text className="block text-xs text-muted-foreground">加载中…</Text>
            </View>
          ) : null}
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} />
          ))}
          {sending ? (
            <View className="flex flex-row items-center gap-2 mt-3">
              <View
                className="rounded-2xl"
                style={{ backgroundColor: '#f1efe9', padding: '8px 14px' }}
              >
                <Text className="block text-xs text-muted-foreground">
                  客服正在思考…
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* 固定底部输入栏 */}
      <View
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          backgroundColor: '#fff',
          borderTop: '1px solid #ecefe3',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <View
          className="flex-1"
          style={{
            backgroundColor: '#f5f3ec',
            borderRadius: '20px',
            padding: '8px 14px',
          }}
        >
          <Input
            className="w-full bg-transparent"
            style={{ fontSize: '14px' }}
            value={input}
            placeholder="说点什么…"
            placeholderClass="text-muted-foreground"
            confirmType="send"
            disabled={sending}
            onInput={(e) => setInput(e.detail.value)}
            onConfirm={handleSend}
          />
        </View>
        <View
          onClick={canSend ? handleSend : undefined}
          className="rounded-full"
          style={{
            backgroundColor: canSend ? BRAND : '#d6d2c5',
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Send size={16} color={canSend ? BRAND_FOREGROUND : '#fff'} />
        </View>
      </View>
    </View>
  )
}

function Bubble({
  role,
  content,
}: {
  role: 'user' | 'assistant'
  content: string
}) {
  if (role === 'assistant') {
    return (
      <View className="flex flex-row items-start gap-2 mb-3">
        <View
          className="rounded-full flex items-center justify-center flex-shrink-0"
          style={{ width: '32px', height: '32px', backgroundColor: BRAND }}
        >
          <Bot size={18} color={BRAND_FOREGROUND} />
        </View>
        <View className="flex-1">
          <View
            className="rounded-2xl rounded-tl-sm"
            style={{
              backgroundColor: '#f1efe9',
              padding: '10px 14px',
              maxWidth: '78%',
            }}
          >
            <Text
              className="block text-sm text-foreground"
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {content}
            </Text>
          </View>
        </View>
      </View>
    )
  }
  return (
    <View className="flex flex-row items-start justify-end gap-2 mb-3">
      <View
        className="rounded-2xl rounded-tr-sm"
        style={{
          backgroundColor: BRAND,
          padding: '10px 14px',
          maxWidth: '78%',
        }}
      >
        <Text
          className="block text-sm"
          style={{ color: BRAND_FOREGROUND, whiteSpace: 'pre-wrap' }}
        >
          {content}
        </Text>
      </View>
    </View>
  )
}
