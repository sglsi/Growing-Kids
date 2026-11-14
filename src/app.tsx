import { PropsWithChildren, useEffect } from 'react';
import { hooks } from '@tarojs/shared';
import { LucideTaroProvider } from 'lucide-react-taro';
import '@/app.css';
import { ensureAuthToken } from '@/services/auth-bootstrap';
import { ensureAiSetting } from '@/services/ai-settings';
import { installAppRuntime } from '@/services/app-runtime';
import { Preset } from './presets';

// ============================================================
// Taro 4.1.9 遗留 bug 兜底（NervJS/taro#16641 同款，4.1.9 未修）：
// @tarojs/shared 的 getComponentsAlias() 在 extraList 里注入了
// StaticText 却没有 PureText → 运行时 mapping 缺 'pure-text' 键。
// 当 Text 节点的最后一个事件被移除时（典型：React 复用同位置的
// 「已选 0 段」/「复制所选」Text，切换 onClick 有无），
// TaroElement.removeEventListener 读 componentsAlias['pure-text']._num
// → undefined → TypeError，经 react-reconciler commitUpdate 抛出，
// 表现为「点击无反应、页面卡死」，退出重进必现。
//
// 修复：tap modifyRemoveEventListener（removeEventListener 内部调用，
// 第三参即 runtime 内部的 getComponentsAlias），在运行时 mapping 上
// 补 'pure-text' = 'static-text' 的别名对象：
//  - 语义正确：无事件的 Text 就是 static-text；
//  - 不动编译期编号：static-text 的 _num 与 wxml 模板 xs 表一致，
//    setData 的 nn 能命中已有模板分支，渲染不受影响；
//  - 仅首次缺失时补，其余路径零开销。
// ============================================================
hooks.tap(
  'modifyRemoveEventListener',
  (_element: unknown, _sideEffect: unknown, getAlias: () => Record<string, { _num: string }>) => {
    try {
      const alias = getAlias()
      if (alias && !alias['pure-text'] && alias['static-text']) {
        alias['pure-text'] = alias['static-text']
      }
    } catch {
      /* 兜底失败不阻塞启动；交互 Text 已同步改 View 双保险 */
    }
  },
);

const App = ({ children }: PropsWithChildren) => {
  // 启动即换身份令牌（严格令牌模式，见 OPS-18 R-技术-09）：
  // 把「首次请求吃一个 401 再重放」的往返提前到冷启动，页面首屏少一次 RTT。
  // 失败不阻塞（network 层还有一次 401 兜底重放）。
  useEffect(() => {
    void ensureAuthToken();
    // 预热 AI 外发开关缓存：本版入口已收起，保留只为服务端闸门做本地对齐（R-合规-02）
    void ensureAiSetting();
    // 运行时保障：版本更新检测 / 网络状态提示 / 全局错误捕获
    // （详见 services/app-runtime.ts；非微信端内部直接返回，零副作用）
    installAppRuntime();
  }, []);

  return (
    <LucideTaroProvider defaultColor="#000" defaultSize={24}>
      <Preset>{children}</Preset>
      {/*
        ⚠️ 这里**只允许**放 App 自身的生命周期与 Provider，不要再往这层加 UI。
        Taro 4.1.9 的 AppWrapper 是 `h(App, props, elements)` —— App 渲染出来的
        **兄弟节点不会挂到页面上**（实测：这里加的 fixed 定位标记节点在 DOM 里根本不存在，
        同样的标记放进 pages/index 就正常）。挂在这里的 UI 一律是死代码。

        已按此结论清理（2026-11-03）：
        · `PolicyConsent`（业务级隐私同意）→ 移到 `pages/index/index.tsx` 首屏
        · `PrivacyGate`（平台级隐私授权）→ 移入 `backup/unused-components/`，
          原因：从未生效（`__usePrivacyCheck__` 默认关，基础库平时不回调），
          真要用必须挂到页面内，做法参考 policy-consent
        · `Toaster`（自绘轻提示）→ 移入 `backup/unused-components/`，全仓零业务调用；
          提示一律用 `Taro.showToast`
      */}
    </LucideTaroProvider>
  );
};

export default App;
