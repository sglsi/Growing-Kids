# 手动拉四角 UI — 打通「自动调正 + 智能高清」完整链路

> 承接《自动调正与智能高清重构方案》Phase 1（几何纠偏）/ Phase 2（智能高清）/ Phase 3（增强）。
> 后端 `manual_corners` 能力自 Phase 1 即已就绪，但**前端从未使用**；本次补齐前端四角透视拉框，闭合完整链路。

---

## 一、背景：后端已有能力，前端无法触达

| 端 | 改动前状态 |
|---|---|
| 后端 `ImageService.straighten` | ✅ 支持 `dto.manual_corners`（四角透视压平，像素级保真，不重画）；自动检测未命中时返回 `debug.needManual=true` |
| 后端 `detectDocumentCorners` | ✅ Phase 3 已接入 OpenCV 自动四角检测（误差 <2px） |
| 前端 `image-editor.tsx` | ❌ **只有矩形裁剪框**，零四角 UI |
| 前端 `processImage` | ❌ 从不传 `manual_corners` |

**结果**：自动检测失败时，后端只能「原样返回 + 提示拉框」，而前端**没有拉框的地方**——链路断在这里。本次接上。

---

## 二、交互设计（双模式，互斥）

在编辑页底部工具栏新增 **「四角拉框」** 按钮，与 **「确定裁剪」** 并列为两种编辑模式：

| 模式 | 用途 | 手势 |
|---|---|---|
| **矩形裁剪**（默认） | 常规裁剪，行为与历史完全一致 | 拖角/边/整体平移 |
| **四角透视** | 把斜拍、带透视的试卷拉平成正面矩形 | 拖动 4 个圆点手柄到试卷四角 |

两模式**互斥**（激活态高亮），切换时各自复位；默认仍是矩形裁剪，**零回归**。

---

## 三、前端实现（`src/components/image-editor.tsx`）

### 3.1 新增状态
```ts
const [cornerMode, setCornerMode] = useState<'rect' | 'quad'>('rect')
const [quad, setQuad] = useState<Corner[]>(DEFAULT_QUAD)   // 归一化 [0,1]，顺序 [tl,tr,br,bl]
const [activeCorner, setActiveCorner] = useState<number | null>(null)
```
`DEFAULT_QUAD` = 内缩 8% 的四边形 `[[0.08,0.08],[0.92,0.08],[0.92,0.92],[0.08,0.92]]`，贴合「试卷略小于取景框」的常见拍摄。

### 3.2 手势（复用既有触摸层机制）
- `hitCorner(x,y)`：在 4 个顶点中找命中半径 `CORNER_HIT=36` 内最近者。
- `onTouchStart`：四角模式优先命中角点；四角模式下不再响应矩形手势。
- `onTouchMove`：拖动角点 → `quad[i] = clamp(触摸点 / imgW|imgH, 0, 1)`。
- **退化保护 `isValidQuad`**：面积 ≥ `MIN_QUAD_AREA(0.05)` 且四叉积同号（凸、不自交），非法则**拒绝该次移动**，绝不提交退化四边形。

坐标口径沿用现有 `measureLayer`（含 -24 外扩）与 `imgW/imgH` 归一化，与矩形裁剪同一套坐标系。

### 3.3 视觉层 `QuadOverlay`
- 四边形**四条边**：白色高光线（按边向量 `rotate` 绘制，`transformOrigin: 0 50%`）；
- **4 个圆点手柄**：直径 22（拖拽中 28 高亮为主题色）；
- **外部遮罩**：整层半透明黑 + `clip-path: polygon(evenodd, ...)` 挖空四边形内部，使框内明亮、框外压暗。纯 `<View>` 实现，无 SVG 依赖。

### 3.4 提交流程
```
点「自动调正」
  ├─ 四角模式 → processImage('auto', { manual_corners: quad })  → 精准透视压平
  └─ 矩形模式 → processImage('auto')                            → 走自动检测

后端返回 debug.needManual=true（自动检测未命中）
  → showModal「未识别到试卷边缘，是否手动拉四角？」
      ├─ 去拉框 → 切四角模式 + 提示「拖动四个圆点框住试卷四角」
      └─ 取消   → 落后端原图（内容保真）到预览
```

**关键改进**：`autoAction='auto'` 首次打开编辑器时，若自动检测失败，**不再静默返回原图**，而是主动引导用户拉框——这正是原链路的断点。

---

## 四、前端 API（`src/services/api.ts`）

`ProcessImageOpts` 新增：
```ts
manual_corners?: [number, number][]   // 归一化 [0,1]，顺序任意（后端会排序）
dewarp_curved?: boolean
```
`processImage` 在 `action === 'auto'` 时透传，**不污染 enhance/erase 的请求体**。

---

## 五、后端加固（`image.service.ts` / `image-dewarp.ts`）

### 5.1 归一化 → 像素还原
前端提交**归一化 [0,1]**；后端按原图尺寸还原为像素：
```ts
const manualCorners = dto.manual_corners?.map(([x, y]): Corner => [x, y])
if (manualCorners && manualCorners.some(([x, y]) => x > 1 || y > 1)) {
  // 已是像素坐标（兼容旧调用方），原样使用
} else if (manualCorners) {
  for (const p of manualCorners) { p[0] *= srcMeta.width; p[1] *= srcMeta.height }
}
```
**口径自动判别**：任一坐标 >1 即视为像素 → 不缩放。双口径均通过测试。

### 5.2 退化四角不崩溃（本轮新发现并修复）
测试暴露：用户误拖出**共线/面积≈0** 的四边形 → 单应矩阵奇异 → `dewarpBuffer` 抛错 → 后端 500。
现在 `straightenImage` **捕获几何异常并回落自动检测**，最终降级为 `needManual`，绝不抛给上层。

---

## 六、测试

新增 `dynamic-tests/run-image-v5.ts`（26 项断言，import 真实模块）：

| 组 | 覆盖 |
|---|---|
| ① 归一化换算 | `[0.1,0.2]`×尺寸 == 原像素（maxDiff 0）；两口径端到端尺寸一致；输出为正面矩形 291×201 |
| ② 乱序鲁棒 | `orderCorners` 归一为 `[tl,tr,br,bl]`；乱序/正序结果尺寸一致 |
| ③ 退化四角 | 共线 → `dewarpBuffer` 抛错可捕获；`straightenImage` 不抛、回落 `needManual` |
| ④ 后端口径 | 源码断言含归一化还原 + `>1` 判别 |
| ⑤ 前端源码 | `cornerMode`/`DEFAULT_QUAD`/`hitCorner`/`isValidQuad`/`QuadOverlay`/「四角拉框」/`Maximize2`/`manual_corners`/`needManual` 兜底；`api.ts` 两参数且仅 auto 透传 |

**全量回归**：

| 套件 | 结果 |
|---|:--:|
| v2（Phase 1） | ✅ 18/18 |
| v3（Phase 2） | ✅ 24/24 |
| v4（Phase 3） | ✅ 37/37 |
| **v5（四角 UI，新）** | ✅ **26/26** |
| 后端 `tsc --noEmit` / `nest build` | ✅ 0 错 / 通过 |
| 前端 `tsc --noEmit`（harness） | ✅ 0 错 |

合计 **105 项动态断言全绿**。

---

## 七、变更文件

**前端**
- `src/components/image-editor.tsx`：四角模式状态、`hitCorner`/`isValidQuad`/`QuadOverlay`、模式切换按钮、`handleAi` 支持 `manual_corners` 与 `needManual` 兜底
- `src/services/api.ts`：`ProcessImageOpts` 增 `manual_corners`/`dewarp_curved`，仅 auto 透传

**后端**
- `src/image/image.service.ts`：归一化四角 → 像素还原（含 `>1` 口径兼容）
- `src/image/image.types.ts`：`manual_corners` 注释更新
- `src/image/image-dewarp.ts`：退化四角捕获并回落（加固）

**测试**
- `dynamic-tests/run-image-v5.ts`（新）

---

## 八、诚实局限

1. **`clip-path: evenodd` 依赖渲染器**：微信小程序 WebView 与主流端支持；若某端不支持，退化为整层半透明（仍可正常拖拽，仅观感略弱）。
2. **仅四点仿射/透视**：四角只能表达透视，无法表达**曲面弯曲**（Phase 3 曲面 dewarp 已判定不达标并撤下，见 Phase 3 报告）。
3. **四角与矩形裁剪互斥**：四角模式下无法同时裁剪；如需「先纠偏再裁剪」，先四角拉平提交、再切回矩形裁剪。
4. **未做四角自动预填**：进入四角模式仍用固定 8% 内缩初值，未把后端自动检测结果回填到 UI（可作为后续优化）。
