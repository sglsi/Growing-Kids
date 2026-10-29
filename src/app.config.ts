/**
 * 隐私保护校验总开关（2026-10-29 修正：由硬编码 true 改为按需开启）
 *
 * ⚠️ **这是「故障依旧」的真正原因，务必理解这一条**：
 * `__usePrivacyCheck__: true` 的含义不是「我要弹隐私弹窗」，而是
 * 「本小程序启用隐私协议机制」——一旦启用，基础库就会**拦截/挂起**所有隐私接口
 * （`chooseMedia` / `chooseImage` / `chooseMessageFile` / `RecorderManager.start`），
 * 直到平台侧《用户隐私保护指引》已配置且用户已同意为止。
 *
 * 本项目托管在第三方平台，隐私指引**还没代配**。此时置 true 等于自锁：
 * 接口被挂起 → Promise 既不 resolve 也不 reject → catch 进不去 → 不弹窗不报错
 * ⇒ 用户看到的就是「所有拍照/相册/录音按钮点了毫无反应」。
 * 开发者工具里那条 `[wxapplib] backgroundfetch privacy fail {"errno":101}`
 * 就是同一机制的旁证——连基础库自己的内部接口都被隐私校验拦下了。
 *
 * 因此默认值改为**关闭**（`GK_PRIVACY_CHECK` 未设时 false）：
 *   - 现在（指引未配）：关掉 ⇐ 功能可用，把我们自己的隐私弹窗作为唯一同意入口
 *   - 指引配好后：`GK_PRIVACY_CHECK=1 pnpm build:weapp` 重新开启（发布必须开启）
 * `scripts/release-check.mjs` 会对「发布态 + 未开启」直接阻断，防止忘记。
 *
 * 自定义弹窗仍由 components/privacy-gate.tsx + utils/privacy.ts 负责，
 * 与这个开关无关——关掉它不会失去「告知并取得同意」这一步。
 *
 * 取值来自 config/index.ts 注入的编译期常量（与 utils/privacy.ts 读同一个值，
 * 杜绝「app.json 开了、代码里以为没开」的错位）。
 */
const PRIVACY_CHECK_ENABLED = typeof PRIVACY_CHECK !== 'undefined' && PRIVACY_CHECK === '1'

export default defineAppConfig({
  __usePrivacyCheck__: PRIVACY_CHECK_ENABLED,
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
    // 用户协议（上线验收第 11 项：提审要求与隐私政策齐备）
    'pages/agreement/index',
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