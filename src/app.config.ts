export default defineAppConfig({
  /**
   * 开启隐私保护校验（必须与 mp 后台「用户隐私保护指引」配套）。
   * 本项目调用 chooseMedia/chooseImage（相册/摄像头）属隐私接口，未声明则
   * **体验版/正式版调用直接失败**；开发版因豁免而无感知。
   * 实际弹窗由 components/privacy-gate.tsx + utils/privacy.ts 处理。
   */
  __usePrivacyCheck__: true,
  pages: [
    'pages/index/index',
    'pages/subject/index',
    'pages/document/index',
    'pages/memory/index',
    'pages/recognize/index',
    'pages/detail/index',
    'pages/library/index',
    'pages/profile/index',
    'pages/privacy/index',
    'pages/chat/index',
    'pages/chat/admin',
    'pages/memory/edit',
    'pages/memory/detail',
    // H5 扫码登录·手机端落地页（电脑浏览器无 wx.login；手机微信扫码后打开本页授权）
    'pages/scan-login/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#faf8f3',
    navigationBarTitleText: '成长学童',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    color: '#9A948A',
    selectedColor: '#0B7A55',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '首页',
        iconPath: './assets/tabbar/house.png',
        selectedIconPath: './assets/tabbar/house-active.png'
      },
      {
        pagePath: 'pages/subject/index',
        text: '复习本',
        iconPath: './assets/tabbar/notebook-pen.png',
        selectedIconPath: './assets/tabbar/notebook-pen-active.png'
      },
      {
        pagePath: 'pages/document/index',
        text: '文档',
        iconPath: './assets/tabbar/file-text.png',
        selectedIconPath: './assets/tabbar/file-text-active.png'
      },
      {
        pagePath: 'pages/memory/index',
        text: '记忆',
        iconPath: './assets/tabbar/book-heart.png',
        selectedIconPath: './assets/tabbar/book-heart-active.png'
      }
    ]
  }
})