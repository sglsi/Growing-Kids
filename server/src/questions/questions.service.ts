import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
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

@Injectable()
export class QuestionsService {
  private applyRange(q: any, startDate?: string, endDate?: string) {
    let query = q
    if (startDate) query = query.gte('recognized_at', startDate)
    if (endDate) query = query.lte('recognized_at', endDate)
    return query
  }

  async list(query: ListQuery): Promise<{ list: QuestionWithSubject[]; total: number; page: number; page_size: number }> {
    const client = getSupabaseClient()
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(100, query.page_size || 50)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let supabaseQuery = client
      .from('questions')
      .select('*, subjects:subject_id(id, name, color)', { count: 'exact' })

    if (query.subject_id) supabaseQuery = supabaseQuery.eq('subject_id', query.subject_id)
    if (query.keyword) supabaseQuery = supabaseQuery.or(`question_content.ilike.%${query.keyword}%,answer_content.ilike.%${query.keyword}%`)
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

  async findOne(id: string): Promise<QuestionWithSubject> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from('questions')
      .select('*, subjects:subject_id(id, name, color)')
      .eq('id', id)
      .single()

    if (error || !data) throw new NotFoundException('题目不存在')
    return data as unknown as QuestionWithSubject
  }

  async create(dto: CreateQuestionDto): Promise<Question> {
    if (!dto.subject_id) throw new BadRequestException('subject_id 不能为空')
    if (!dto.question_content) throw new BadRequestException('question_content 不能为空')

    const client = getSupabaseClient()
    const payload: Record<string, unknown> = {
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

  async update(id: string, dto: UpdateQuestionDto): Promise<Question> {
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
      .select()
      .single()

    if (error || !data) throw new NotFoundException('题目不存在')
    return data as unknown as Question
  }

  async remove(id: string): Promise<{ id: string }> {
    const client = getSupabaseClient()
    const { error } = await client.from('questions').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { id }
  }

  async overview() {
    const client = getSupabaseClient()
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

    const [totalRes, weekRes, pendingRes, subjectRes, recentRes] = await Promise.all([
      client.from('questions').select('id', { count: 'exact', head: true }),
      client.from('questions').select('id', { count: 'exact', head: true }).gte('recognized_at', weekAgo),
      client.from('questions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      client
        .from('questions')
        .select('subject_id, subjects:subject_id(name, color)')
        .then(async (r) => {
          // 聚合各学科总数 + 本周数
          const { data: weekData } = await client
            .from('questions')
            .select('subject_id')
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
