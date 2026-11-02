export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '汇总导出' })
  : { navigationBarTitleText: '汇总导出' }
