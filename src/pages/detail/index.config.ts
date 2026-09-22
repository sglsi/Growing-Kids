export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '题目详情' })
  : { navigationBarTitleText: '题目详情' }
