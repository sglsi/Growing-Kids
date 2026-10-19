import Taro from '@tarojs/taro';

/**
 * 小程序调试工具
 * 在开发版/体验版自动开启调试模式
 * 支持微信小程序
 */
export function devDebug() {
  const env = Taro.getEnv();
  if (env === Taro.ENV_TYPE.WEAPP) {
    try {
      const accountInfo = Taro.getAccountInfoSync();
      const envVersion = accountInfo.miniProgram.envVersion;
      console.log('[Debug] envVersion:', envVersion);

      if (envVersion !== 'release') {
        // 开发者工具模拟器（systemInfo.platform === 'devtools'）不支持
        // setEnableDebug，调用会报「开发者工具暂时不支持此 API 调试」，
        // 直接跳过以免刷屏；真机（platform 为 ios/android）仍会自动开启。
        const systemInfo = Taro.getSystemInfoSync();
        if (systemInfo?.platform === 'devtools') {
          console.log('[Debug] 开发者工具模拟器不支持 setEnableDebug，已跳过');
          return;
        }
        Taro.setEnableDebug({ enableDebug: true });
      }
    } catch (error) {
      console.error('[Debug] 开启调试模式失败:', error);
    }
  }
}
