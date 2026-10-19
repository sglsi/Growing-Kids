export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '知识库管理' })
  : { navigationBarTitleText: '知识库管理' }
