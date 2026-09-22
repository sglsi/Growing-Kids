export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '错题本' })
  : { navigationBarTitleText: '错题本' }
