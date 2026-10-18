export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '智能客服' })
  : { navigationBarTitleText: '智能客服' }
