import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import { cleanStr, cleanDate } from '../shared/query-param'
import type {
  Question,
  QuestionWithSubject,
  CreateQuestionDto,
  UpdateQuestionDto,
} from './questions.types'

interface ListQuery {
  subject_id?: string
  keyword?: string
  start_date?: string
  end_date?: string
  mastered?: boolean
  page?: number
  page_size?: number
}

/**
 * ⚠️ service_role 绕过 RLS ⇒ 每个查询都必须 .eq('user_id', userId)
 * 2026-10-19 补齐：此前本服务完全没有用户隔离（不写也不过滤 user_id），
 * 与 timeline.service 的约定不一致，注册进 app.module 前必须先补上，
 * 否则任意用户可读写他人题目。
 */
@Injectable()
export class QuestionsService {
  private applyRange(q: any, startDate?: string, endDate?: string) {
    let query = q
    // 脏参数防御：非日期字符串喂给 recognized_at 会让 Postgres 解析失败直接 500
    const start = cleanDate(startDate)
    const end = cleanDate(endDate)
    if (start) query = query.gte('recognized_at', start)
    if (end) query = query.lte('recognized_at', end)
    return query
  }

  async list(
    userId: string,
    query: ListQuery,
  ): Promise<{ list: QuestionWithSubject[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 50)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let supabaseQuery = client
      .from('questions')
      .select('*, subjects:subject_id(id, name, color)', { count: 'exact' })
      .eq('user_id', userId)

    const subjectId = cleanStr(query.subject_id)
    const keyword = cleanStr(query.keyword)
    if (subjectId) supabaseQuery = supabaseQuery.eq('subject_id', subjectId)
    if (keyword) supabaseQuery = supabaseQuery.or(`question_content.ilike.%${keyword}%,answer_content.ilike.%${keyword}%`)
    if (query.mastered !== undefined) supabaseQuery = supabaseQuery.eq('mastered', query.mastered)
    supabaseQuery = this.applyRange(supabaseQuery, query.start_date, query.end_date)
    supabaseQuery = supabaseQuery.order('recognized_at', { ascending: false }).range(from, to)

    const { data, error, count } = await supabaseQuery
    if (error) throw new Error(error.message)

    return {
      list: (data || []) as unknown as QuestionWithSubject[],
      total: count || 0,
      page,
      page_size: pageSize,
    }
  }

  async findOne(userId: string, id: string): Promise<QuestionWithSubject> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from('questions')
      .select('*, subjects:subject_id(id, name, color)')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (error || !data) throw new NotFoundException('题目不存在')
    return data as unknown as QuestionWithSubject
  }

  async create(userId: string, dto: CreateQuestionDto): Promise<Question> {
    if (!dto.subject_id) throw new BadRequestException('subject_id 不能为空')
    if (!dto.question_content) throw new BadRequestException('question_content 不能为空')

    const client = getSupabaseClient()
    const payload: Record<string, unknown> = {
      user_id: userId,
      subject_id: dto.subject_id,
      question_content: dto.question_content,
      answer_content: dto.answer_content || '',
      solution: dto.solution || '',
      wrong_answer: dto.wrong_answer || '',
      source: dto.source || '',
      status: dto.status || (dto.answer_content ? 'answered' : 'pending'),
      mastered: dto.mastered ?? false,
    }
    if (payload.mastered) payload.mastered_at = new Date().toISOString()
    if (dto.question_image_keys) payload.question_image_keys = dto.question_image_keys
    if (dto.answer_image_keys) payload.answer_image_keys = dto.answer_image_keys

    const { data, error } = await client
      .from('questions')
      .insert(payload)
      .select()
      .single()

    if (error) throw new Error(error.message)
    return data as unknown as Question
  }

  async update(userId: string, id: string, dto: UpdateQuestionDto): Promise<Question> {
    const client = getSupabaseClient()
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    const fields: (keyof UpdateQuestionDto)[] = [
      'subject_id', 'question_content', 'answer_content', 'solution',
      'wrong_answer', 'source', 'status', 'question_image_keys', 'answer_image_keys',
    ]
    for (const f of fields) {
      if (dto[f] !== undefined) payload[f] = dto[f] as never
    }
    if (dto.mastered !== undefined) {
      payload.mastered = dto.mastered
      payload.mastered_at = dto.mastered ? new Date().toISOString() : null
    }

    const { data, error } = await client
      .from('questions')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single()

    if (error || !data) throw new NotFoundException('题目不存在')
    return data as unknown as Question
  }

  async remove(userId: string, id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    // 带 .select() 才能拿到实际删除行数：越权删除时返回空，必须报 404 而不是假装成功
    const { data, error } = await client
      .from('questions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) throw new NotFoundException('题目不存在')
    return { id }
  }

  async overview(userId: string) {
    const client = getSupabaseClient()
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

    const [totalRes, weekRes, pendingRes, subjectRes, recentRes] = await Promise.all([
      client.from('questions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      client.from('questions').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('recognized_at', weekAgo),
      client.from('questions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending'),
      client
        .from('questions')
        .select('subject_id, subjects:subject_id(name, color)')
        .eq('user_id', userId)
        .then(async (r) => {
          // 聚合各学科总数 + 本周数
          const { data: weekData } = await client
            .from('questions')
            .select('subject_id')
            .eq('user_id', userId)
            .gte('recognized_at', weekAgo)
          const weekCountMap: Record<string, number> = {}
          ;(weekData || []).forEach((row: any) => {
            weekCountMap[row.subject_id] = (weekCountMap[row.subject_id] || 0) + 1
          })
          const map: Record<string, { subject_id: string; name: string; color: string; count: number; week_count: number }> = {}
          ;(r.data || []).forEach((row: any) => {
            const sid = row.subject_id
            const meta = row.subjects
            if (!map[sid]) {
              map[sid] = {
                subject_id: sid,
                name: meta?.name || '未分类',
                color: meta?.color || 'gray-500',
                count: 0,
                week_count: weekCountMap[sid] || 0,
              }
            }
            map[sid].count += 1
          })
          return Object.values(map)
        }),
      client
        .from('questions')
        .select('*, subjects:subject_id(id, name, color)')
        .eq('user_id', userId)
        .order('recognized_at', { ascending: false })
        .limit(6),
    ])

    return {
      total: totalRes.count || 0,
      week_total: weekRes.count || 0,
      pending: pendingRes.count || 0,
      subject_stats: subjectRes,
      recent: (recentRes.data || []) as unknown as QuestionWithSubject[],
    }
  }
}
