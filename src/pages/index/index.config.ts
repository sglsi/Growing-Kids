export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '错题巩固' })
  : { navigationBarTitleText: '错题巩固' }
