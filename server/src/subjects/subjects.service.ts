import { Injectable } from '@nestjs/common'
import { getSupabaseClient } from '../storage/database/supabase-client'
import type { Subject } from './subjects.types'

@Injectable()
export class SubjectsService {
  async findAll(): Promise<Subject[]> {
    const client = getSupabaseClient()
    const { data, error } = await client
      .from('subjects')
      .select('id, name, color, sort_order, created_at')
      .order('sort_order', { ascending: true })

    if (error) throw new Error(error.message)
    return (data || []) as Subject[]
  }
}
