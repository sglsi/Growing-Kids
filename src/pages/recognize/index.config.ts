export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '识别导入' })
  : { navigationBarTitleText: '识别导入' }
