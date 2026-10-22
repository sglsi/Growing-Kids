import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { LLMClient } from '../ai/llm-provider'
import { getSupabaseClient } from '../storage/database/supabase-client'
import type { ChatMessage, ChatSendResult, KnowledgeArticle } from './chat.types'

const KNOWLEDGE_TABLE = 'knowledge_articles'
const MESSAGE_TABLE = 'chat_messages'
const KNOWLEDGE_SELECT =
  'id, title, content, category, tags, is_active, sort_order, created_at, updated_at'
const MESSAGE_SELECT = 'id, session_id, user_id, role, content, created_at'
const MODEL = 'doubao-seed-2-0-pro-260215'

// 知识库进程内缓存（5 分钟），避免每次问答都全量查表
let knowledgeCache: { articles: KnowledgeArticle[]; expireAt: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

const FALLBACK_REPLY = '这个问题我还在学习中，您可以描述得更具体一些，或通过意见反馈告诉我们～'
const OFF_TOPIC_HINT = '这个小助手主要是解答「成长学童」小程序的使用问题哦，关于小程序功能的任何疑问都可以问我～'

const SYSTEM_PROMPT_TEMPLATE = (articles: KnowledgeArticle[]) => `你是「成长学童小助手」，负责回答用户关于「成长学童」小程序的功能和使用问题。

# 身份与风格
- 称呼用户为"您"
- 亲切耐心、温和有礼
- 回答精炼，适合移动端阅读；适合时优先分点或分步骤
- 不确定时直接说"我还在学习"
- 使用纯文本回答，不要输出任何 markdown 代码块标记（不要 \`\`\`json / \`\`\`markdown 等）

# 回答原则
1. 严格只回答与「成长学童」小程序功能、使用、问题反馈相关的话题。
2. 用户问到与小程序无关的话题（时事、闲聊、第三方推荐、学术答疑、政治敏感等），礼貌地引导回小程序话题，例如："${OFF_TOPIC_HINT}"
3. 知识库覆盖到的问题：必须基于下面的【知识库】回答，不要凭空捏造功能。
4. 知识库未覆盖但属于小程序范畴的问题：礼貌承认并引导反馈，例如："${FALLBACK_REPLY}"

# 【知识库】
以下是当前生效的产品知识条目（按 sort_order 升序），请优先基于这些内容回答：
${articles.length === 0
  ? '（知识库暂无内容，所有问题统一回复："' + FALLBACK_REPLY + '"）'
  : articles
      .map((a, i) => `${i + 1}. 【${a.title}】\n${a.content}`)
      .join('\n\n')}

回答时不需要引用编号，必要时把多条知识自然融合即可。`

@Injectable()
export class ChatService {
  private llm?: LLMClient

  private getLlm(): LLMClient {
    if (!this.llm) this.llm = new LLMClient()
    return this.llm
  }

  // ----------------- 知识库 CRUD -----------------

  async listKnowledge(): Promise<KnowledgeArticle[]> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(KNOWLEDGE_TABLE)
      .select(KNOWLEDGE_SELECT)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    return (data || []) as unknown as KnowledgeArticle[]
  }

  private async getActiveArticles(): Promise<KnowledgeArticle[]> {
    if (knowledgeCache && knowledgeCache.expireAt > Date.now()) {
      return knowledgeCache.articles
    }
    const client = getSupabaseClient()
    const { data, error } = await client
      .from(KNOWLEDGE_TABLE)
      .select(KNOWLEDGE_SELECT)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (error) throw new Error(error.message)
    const list = (data || []) as unknown as KnowledgeArticle[]
    knowledgeCache = { articles: list, expireAt: Date.now() + CACHE_TTL_MS }
    return list
  }

  private invalidateCache() {
    knowledgeCache = null
  }

  async createKnowledge(input: {
    title: string
    content: string
    category?: string | null
    tags?: string[]
    is_active?: boolean
    sort_order?: number
  }): Promise<KnowledgeArticle> {
    if (!input.title?.trim() || !input.content?.trim()) {
      throw new BadRequestException('title 和 content 必填')
    }
    const client = getSupabaseClient()
    const payload = {
      title: input.title.trim(),
      content: input.content.trim(),
      category: input.category?.trim() || null,
      tags: input.tags ?? [],
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 99,
    }
    const { data, error } = await client
      .from(KNOWLEDGE_TABLE)
      .insert(payload)
      .select(KNOWLEDGE_SELECT)
      .single()
    if (error) throw new Error(error.message)
    this.invalidateCache()
    return data as unknown as KnowledgeArticle
  }

  async updateKnowledge(
    id: string,
    patch: Partial<
      Pick<KnowledgeArticle, 'title' | 'content' | 'category' | 'tags' | 'is_active' | 'sort_order'>
    >,
  ): Promise<KnowledgeArticle> {
    if (!id) throw new BadRequestException('id 必填')
    const client = getSupabaseClient()
    // ⚠️ updated_at 必须显式写：knowledge_articles 只有 default now()（仅覆盖 insert），
    //    update 时不会自动刷新。库级触发器见 migrations/0008_updated_at_trigger.sql（双保险）。
    const { data, error } = await client
      .from(KNOWLEDGE_TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(KNOWLEDGE_SELECT)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException('知识条目不存在')
    this.invalidateCache()
    return data as unknown as KnowledgeArticle
  }

  async removeKnowledge(id: string): Promise<{ id: string }> {
    if (!id) throw new BadRequestException('id 必填')
    const client = getSupabaseClient()
    const { error } = await client.from(KNOWLEDGE_TABLE).delete().eq('id', id)
    if (error) throw new Error(error.message)
    this.invalidateCache()
    return { id }
  }

  // ----------------- 对话 -----------------

  async sendMessage(
    userId: string,
    sessionId: string | null,
    content: string,
  ): Promise<ChatSendResult> {
    if (!content?.trim()) throw new BadRequestException('消息内容不能为空')
    const sid = sessionId?.trim() || randomUUID()
    const trimmed = content.trim()
    const client = getSupabaseClient()

    // 1) 写用户消息
    const { data: userRow, error: userErr } = await client
      .from(MESSAGE_TABLE)
      .insert({ session_id: sid, user_id: userId, role: 'user', content: trimmed })
      .select(MESSAGE_SELECT)
      .single()
    if (userErr) throw new Error(userErr.message)
    const userRowCast = userRow as unknown as ChatMessage

    // 2) 取该 session 最近 20 条历史（含本次 user 消息，构造多轮）
    const { data: history, error: histErr } = await client
      .from(MESSAGE_TABLE)
      .select(MESSAGE_SELECT)
      .eq('session_id', sid)
      .order('created_at', { ascending: true })
      .limit(20)
    if (histErr) throw new Error(histErr.message)
    const msgs = (history || []) as unknown as ChatMessage[]

    // 3) 构造 system + 多轮 messages
    const articles = await this.getActiveArticles()
    const systemContent = SYSTEM_PROMPT_TEMPLATE(articles)
    const llmMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemContent },
      ...msgs.map((m) => ({ role: m.role, content: m.content })),
    ]

    // 4) 调 LLM
    let replyText: string
    try {
      const resp = await this.getLlm().invoke(llmMessages, {
        model: MODEL,
        temperature: 0.6,
      })
      replyText = (resp?.content || '').trim() || FALLBACK_REPLY
    } catch (e) {
      console.error('[chat] LLM 调用失败:', e)
      replyText = FALLBACK_REPLY
    }

    // 5) 写助手消息
    const { data: asstRow, error: asstErr } = await client
      .from(MESSAGE_TABLE)
      .insert({ session_id: sid, user_id: userId, role: 'assistant', content: replyText })
      .select(MESSAGE_SELECT)
      .single()
    if (asstErr) throw new Error(asstErr.message)
    const asstRowCast = asstRow as unknown as ChatMessage

    return {
      session_id: sid,
      reply: replyText,
      user_message_id: userRowCast.id,
      assistant_message_id: asstRowCast.id,
    }
  }

  /**
   * 通用对话（思傅 2026-10-22）：中性 LLM 问答，**不带**小程序知识库与使用范围人设，
   * 区别于上面的智能客服 sendMessage。走同一条降级链（扣子→DeepSeek→混元），
   * 扣子时由 bot 自身中性人设作答。history 由前端传入以支持多轮（本服务不落库）。
   */
  async genericChat(
    message: string,
    history?: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string> {
    const msg = (message || '').trim()
    if (!msg) return ''
    const prior = Array.isArray(history)
      ? history
          .filter((h) => (h?.role === 'user' || h?.role === 'assistant') && typeof h?.content === 'string' && h.content.trim())
          .map((h) => ({ role: h.role, content: h.content }))
      : []
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      ...prior,
      { role: 'user', content: msg },
    ]
    try {
      const resp = await this.getLlm().invoke(messages, { temperature: 0.6 })
      return (resp?.content || '').trim()
    } catch (e) {
      console.error('[chat] 通用对话 LLM 调用失败:', e)
      return '抱歉，AI 助手暂时不可用，请稍后再试。'
    }
  }

  async listMessages(sessionId: string, userId?: string): Promise<ChatMessage[]> {
    if (!sessionId) throw new BadRequestException('sessionId 必填')
    const client = getSupabaseClient()
    let q = client
      .from(MESSAGE_TABLE)
      .select(MESSAGE_SELECT)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200)
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data || []) as unknown as ChatMessage[]
  }
}
