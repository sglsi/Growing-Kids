export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '成长学伴' })
  : { navigationBarTitleText: '成长学伴' }
