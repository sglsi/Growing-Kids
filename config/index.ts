import fs from 'node:fs';
import path from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import { UnifiedViteWeappTailwindcssPlugin } from 'weapp-tailwindcss/vite';
import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import type { PluginItem } from '@tarojs/taro/types/compile/config/project';
import dotenv from 'dotenv';
import devConfig from './dev';
import prodConfig from './prod';
import pkg from '../package.json';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const resolvePort = (value: string | undefined, fallback: number): number => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
};

const h5Port = resolvePort(process.env.PORT, 5000);
const serverPort = resolvePort(process.env.SERVER_PORT, 3000);

const generateTTProjectConfig = (outputRoot: string) => {
  const config = {
    miniprogramRoot: './',
    projectname: 'growing-kids',
    appid: process.env.TARO_APP_TT_APPID || '',
    setting: {
      urlCheck: false,
      es6: false,
      postcss: false,
      minified: false,
    },
  };
  const outputDir = path.resolve(__dirname, '..', outputRoot);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(
    path.resolve(outputDir, 'project.config.json'),
    JSON.stringify(config, null, 2),
  );
};

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'vite'>(async (merge, _env) => {
  const outputRootMap: Record<string, string> = {
    weapp: 'dist',
    tt: 'dist-tt',
    h5: 'dist-web',
  };
  const defaultOutputRoot = outputRootMap[process.env.TARO_ENV || ''] || 'dist';
  const outputRoot = process.env.OUTPUT_ROOT?.trim() || defaultOutputRoot;
  const isH5 = process.env.TARO_ENV === 'h5';

  /**
   * 小程序端 `global` 垫片。
   *
   * 背景：`@tarojs/runtime` 在初始化时会用 Node 的 `global` 对象来拼装 window：
   *   Object.getOwnPropertyNames(global || {})
   * 真实微信运行时里 `global` 存在；但浏览器沙箱（WorkBuddy 的 H5 预览模拟器等）里
   * `global` 未定义，`global || {}` 只能防 null/undefined、防不住 ReferenceError，
   * 于是 `taro.js` 模块初始化直接抛 `ReferenceError: global is not defined`。
   * 该模块一旦失败，其 exports 会被置空，后续 chunk（vendors/common/pages）再
   * `require('./taro.js')` 只能拿到空壳，最终报出
   * `Cannot read properties of undefined (reading 'createContext')` 这类连环错误。
   *
   * 这里在 app.js 产物最前面注入垫片，保证 taro.js 加载前 `global` 已就绪。
   * 微信/飞书真机与开发者工具中 `global` 已存在，此代码为空操作，不影响原行为。
   */
  const miniGlobalPolyfillPlugin = {
    name: 'mini-global-polyfill',
    renderChunk(code: string, chunk: any) {
      const isAppEntry =
        chunk.isEntry &&
        (/(^|\/)app\.js$/.test(chunk.fileName || '') ||
          /(^|\/)app\.tsx?$/.test(chunk.facadeModuleId || ''));
      if (!isAppEntry) return null;
      const polyfill = "if(typeof global==='undefined'){globalThis.global=globalThis}\n";
      // 保持 "use strict" 指令位于文件首行，避免垫片把它挤成普通字符串而丢失严格模式
      const strictPrefix = '"use strict";';
      const patched = code.startsWith(strictPrefix)
        ? strictPrefix + polyfill + code.slice(strictPrefix.length)
        : polyfill + code;
      return { code: patched, map: null };
    },
  };

  const buildMiniCIPluginConfig = () => {
    // 微信 appid：优先显式 TARO_APP_WEAPP_APPID，回退平台注入的 WX_APPID
    const weappAppid = process.env.TARO_APP_WEAPP_APPID || process.env.WX_APPID;
    // 微信 CI 上传必须同时具备有效的「代码上传密钥」（公众平台下载，非 AppSecret）。
    // 密钥为空/0 字节时不启用 CI 插件，保持“仅编译”行为，避免构建因无效密钥失败。
    const weappKeyPath = path.resolve(__dirname, '../key/private.appid.key');
    const hasWeappConfig =
      !!weappAppid &&
      fs.existsSync(weappKeyPath) &&
      fs.statSync(weappKeyPath).size > 0;
    const hasTTConfig = !!process.env.TARO_APP_TT_EMAIL;
    if (!hasWeappConfig && !hasTTConfig) {
      return [];
    }
    const miniCIConfig: Record<string, any> = {
      version: pkg.version,
      desc: pkg.description,
    };
    if (hasWeappConfig) {
      miniCIConfig.weapp = {
        appid: weappAppid,
        privateKeyPath: 'key/private.appid.key',
      };
    }
    if (hasTTConfig) {
      miniCIConfig.tt = {
        email: process.env.TARO_APP_TT_EMAIL,
        password: process.env.TARO_APP_TT_PASSWORD,
        setting: {
          skipDomainCheck: true,
        },
      };
    }
    return [['@tarojs/plugin-mini-ci', miniCIConfig]] as PluginItem[];
  };

  const baseConfig: UserConfigExport<'vite'> = {
    projectName: 'growing-kids',
    date: '2026-1-13',
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
    },
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot,
    plugins: ['@tarojs/plugin-generator', ...buildMiniCIPluginConfig()],
    defineConstants: {
      // 小程序端 baseURL 缺省值：未配置 PROJECT_DOMAIN 时默认打本机 3001 后端
      // （微信开发者工具联调标准姿势：开发者工具 → 详情 → 本地设置 → 不校验域名）。
      // ⚠️ H5 端必须保持空串——devServer 已把 /api 代理到 localhost:SERVER_PORT，
      //    填了绝对地址反而绕过代理直连，开发环境下会 CORS/连不上。
      //    小程序端（weapp/tt）才走 PROJECT_DOMAIN，缺省兜底本机 3001。
      PROJECT_DOMAIN: JSON.stringify(
        process.env.TARO_ENV === 'h5'
          ? ''
          : process.env.PROJECT_DOMAIN || 'http://127.0.0.1:3001',
      ),
      TARO_ENV: JSON.stringify(process.env.TARO_ENV),
    },
    copy: {
      patterns: [],
      options: {},
    },
    ...(process.env.TARO_ENV === 'tt' && {
      tt: {
        appid: process.env.TARO_APP_TT_APPID,
        projectName: 'growing-kids',
      },
    }),
    jsMinimizer: 'esbuild',
    framework: 'react',
    compiler: {
      type: 'vite',
      vitePlugins: [
        {
          name: 'postcss-config-loader-plugin',
          config(config) {
            // 通过 postcss 配置注册 tailwindcss 插件
            if (typeof config.css?.postcss === 'object') {
              config.css?.postcss.plugins?.unshift(tailwindcss());
            }
          },
        },
        {
          name: 'hmr-config-plugin',
          config() {
            if (!process.env.PROJECT_DOMAIN) {
              return;
            }
            return {
              server: {
                hmr: {
                  overlay: true,
                  path: '/hot/vite-hmr',
                  port: 6000,
                  clientPort: 443,
                  timeout: 30000,
                },
              },
            };
          },
        },
        ...(isH5
          ? []
          : [
              miniGlobalPolyfillPlugin,
              UnifiedViteWeappTailwindcssPlugin({
                rem2rpx: true,
                cssEntries: [path.resolve(__dirname, '../src/app.css')],
              }),
            ]),
        ...(process.env.TARO_ENV === 'tt'
          ? [
              {
                name: 'generate-tt-project-config',
                closeBundle() {
                  generateTTProjectConfig(outputRoot);
                },
              },
            ]
          : []),
      ],
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
    h5: {
      publicPath: './',
      staticDirectory: 'static',
      router: {
        mode: 'hash',
      },
      devServer: {
        port: h5Port,
        host: '0.0.0.0',
        open: false,
        proxy: {
          '/api': {
            target: `http://localhost:${serverPort}`,
            changeOrigin: true,
          },
        },
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css',
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        pxtransform: {
          enable: true,
          config: {
            platform: 'h5',
          },
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
    rn: {
      appName: 'growing-kids',
      postcss: {
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        },
      },
    },
  };

  process.env.BROWSERSLIST_ENV = process.env.NODE_ENV;

  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
