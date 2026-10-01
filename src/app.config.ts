export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/subject/index',
    'pages/document/index',
    'pages/memory/index',
    'pages/recognize/index',
    'pages/detail/index',
    'pages/library/index',
    'pages/profile/index',
    'pages/memory/edit',
    'pages/memory/detail'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#faf8f3',
    navigationBarTitleText: '成长学童',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    color: '#9A948A',
    selectedColor: '#BE3E2D',
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