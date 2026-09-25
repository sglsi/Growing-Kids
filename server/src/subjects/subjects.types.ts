export interface Subject {
  id: string
  user_id: string
  name: string
  color: string
  sort_order: number
  created_at: string
}

/** 新用户首次访问时铺设的默认学科 */
export const DEFAULT_SUBJECTS: { name: string; color: string; sort_order: number }[] = [
  { name: '语文', color: 'red-500', sort_order: 1 },
  { name: '数学', color: 'blue-500', sort_order: 2 },
  { name: '英语', color: 'green-500', sort_order: 3 },
  { name: '物理', color: 'purple-500', sort_order: 4 },
  { name: '化学', color: 'orange-500', sort_order: 5 },
  { name: '生物', color: 'teal-500', sort_order: 6 },
  { name: '历史', color: 'amber-500', sort_order: 7 },
  { name: '地理', color: 'cyan-500', sort_order: 8 },
  { name: '政治', color: 'pink-500', sort_order: 9 },
  { name: '生活', color: 'gray-500', sort_order: 10 },
]
