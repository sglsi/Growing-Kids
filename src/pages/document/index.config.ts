export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '汇总打印' })
  : { navigationBarTitleText: '汇总打印' }
