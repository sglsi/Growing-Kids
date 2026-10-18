export interface KnowledgeArticle {
  id: string
  title: string
  content: string
  category: string | null
  tags: string[]
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  session_id: string
  user_id: string | null
  role: ChatRole
  content: string
  created_at: string
}

export interface ChatSendResult {
  session_id: string
  reply: string
  user_message_id: string
  assistant_message_id: string
}
