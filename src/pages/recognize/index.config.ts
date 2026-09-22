export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '拍照识别' })
  : { navigationBarTitleText: '拍照识别' }
