export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '资料' })
  : { navigationBarTitleText: '资料' }
