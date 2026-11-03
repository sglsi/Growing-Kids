# 未使用组件备份

这里放**已确认不生效 / 零业务调用**、但从代码上仍有可能被重新启用的组件。
移出 `src/` 的目的：避免后来人（包括 AI）误以为它们在工作，反复在死代码上排查。

⚠️ 本目录**不参与编译**（不在 `src/` 下，Taro 不会打包）。

| 文件 | 原名 | 移出原因 | 什么情况下会需要它 |
|---|---|---|---|
| `privacy-gate.tsx` | `src/components/privacy-gate.tsx` | 微信**平台级**隐私授权弹窗，挂在 `app.tsx` 里从未生效——Taro 4.1.9 不挂载 App 渲染出的兄弟节点；且 `__usePrivacyCheck__` 默认关，基础库平时根本不回调 | 若将来要开 `__usePrivacyCheck__`（不推荐，它曾自锁导致所有隐私接口挂起），**必须挂到具体页面内**，做法参照 `src/components/policy-consent.tsx`（首帧 `useState(() => ...)`，不要用 `useEffect` 里 setVisible） |
| `ui-toast.tsx` | `src/components/ui/toast.tsx` | 自绘轻提示（`Toaster` 容器 + `toast()` 函数）。全仓零业务调用，H5 错误兜底页也已改 `Taro.showToast` | 若将来需要「带标题+描述+操作按钮」的富提示，且愿意解决「必须挂进页面」的问题 |

## 恢复方式

```bash
git mv backup/unused-components/privacy-gate.tsx src/components/privacy-gate.tsx
# 然后在具体页面里挂载（不要挂 app.tsx）
```

移出时已同步改动：
- `src/app.tsx` —— 删掉两个 import 与两个节点，留下「这层只放 Provider / 生命周期」的注释
- `src/presets/h5-error-boundary.tsx` —— `toast.success/warning` 改 `Taro.showToast`

## 相关事实（2026-11-03 实测）

Taro 4.1.9 的 `AppWrapper` 是 `h(App, props, elements)`：App 渲染出来的**兄弟节点不会被 append 到页面**。
判据很直接——在 App 根加一个 `position: fixed` 的标记节点，DOM 里查不到；同样的标记放进 `pages/index` 就正常。
`PolicyConsent` 就是踩了这个坑（日志有 `mount`、DOM 没有），现已挂在首页。
