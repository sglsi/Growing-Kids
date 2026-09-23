export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '复习本' })
  : { navigationBarTitleText: '复习本' }
