import { PropsWithChildren } from 'react';
import { hooks } from '@tarojs/shared';
import { LucideTaroProvider } from 'lucide-react-taro';
import '@/app.css';
import { Toaster } from '@/components/ui/toast';
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
  return (
    <LucideTaroProvider defaultColor="#000" defaultSize={24}>
      <Preset>{children}</Preset>
      <Toaster />
    </LucideTaroProvider>
  );
};

export default App;
