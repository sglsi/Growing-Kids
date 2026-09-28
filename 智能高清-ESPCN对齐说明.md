# 智能高清（问题三）：对齐 ESPCN 参考实现

> 配套包 `growing-kids-fixes-superres-espcn.zip`，仅含本次改动文件，按仓库相对路径覆盖即可。

## 参考来源

用户提供的 `ESPCN-master.zip`（PyTorch 实现，CVPR2016 ESPCN）。该包：
- 是 **Python/PyTorch** 代码，项目后端是 **Node.js + sharp**，**不能直跑**；
- `epochs/` 目录**为空**（无训练权重），权重在百度网盘，**环境内无法下载**。

故按用户指示「不能直接用则借鉴设计思想、复用成熟调校参数」——把 ESPCN 的**架构与推理约定**对齐进项目已有的纯 JS ESPCN 引擎，而非引入 PyTorch 依赖。

## ESPCN 的核心设计（已复用）

| 要点 | 参考实现（model.py / test_image.py） | 项目落地 |
|---|---|---|
| 仅对**亮度 Y** 做超分，色度 Cb/Cr 仅上采样 | `img.convert('YCbCr')` 取 Y；Cb/Cr `Image.BICUBIC` 上采样 | ✅ 转 YCbCr，Y 走 SR，Cb/Cr 走 sharp `cubic` 上采样 |
| 子像素重排 PixelShuffle | `nn.PixelShuffle` | ✅ 已有 `pixelShuffle`，已校验与 PyTorch 约定一致 |
| 激活 conv1/conv2=tanh、输出=sigmoid | `F.tanh / F.sigmoid` | ✅ 引擎新增 `act`/`outAct`，默认 tanh/sigmoid |
| 输入 [0,1] 归一化 | `transforms.ToTensor()` 除以 255 | ✅ `superResolveESPCN` 内部 /255，输出 ×255 |
| 放大倍率 2/3/4/8 | `upscale_factor` | ✅ 接口已支持 2/3/4（默认 2） |

## 本次改动（文件）

### `push-ready/server/src/image/image-superres.ts`（修改）
1. **引擎数值约定对齐论文**：`superResolveESPCN` 输入 Y 先 /255 归一化，conv1/conv2 走 `tanh`，conv3 线性，pixel_shuffle 后过 `sigmoid`，再 ×255。
2. **`SRWeights` 新增 `act`/`outAct` 字段**，`conv2d` 支持 `tanh|relu|none` 激活——真实学习权重（经 `ESPCN_WEIGHTS_URL` 载入）即按此约定运行。
3. **色彩管线改为标准 YCbCr**：原实现用 Rec.601 亮度近似 + 整图 Lanczos；现改为 `img.convert('YCbCr')` 同款矩阵，Cb/Cr 以**双三次**上采样（对齐 `Image.BICUBIC`），再精确反变换回 RGB（已验证 RGB→YCbCr→RGB 互逆、灰图无色偏）。
4. **`buildAnalyticESPCN` 占位权重**注明采用 `act/outAct='none'`（线性）——无学习权重时退化为可用上采样，避免 tanh/sigmoid 把图洗白；真实权重载入后引擎自动按论文激活运行。

### `dynamic-tests/run-issue-superres.ts`（新增）
24 项回归：pixelShuffle 与 PyTorch 约定逐元素一致、conv2d 三激活、占位/真实 tanh-sigmoid 引擎 bounded、YCbCr 互逆、enhanceImage x2/x3/x4 端到端尺寸/确定性/非退化、相对纯 Lanczos 更锐、灰图无色彩漂移。

## 验证结果
- `run-issue-superres`：**PASS 24 / FAIL 0**
- `run-image-v3`（旧 8 参 `conv2d` 签名）：**24/0**（向后兼容）
- `run-issue-three-features`：**56/0**
- `tsc --noEmit`：**EXIT=0**

## 诚实边界
- **真实 ESPCN 神经网络超分需要训练权重**，本环境无法获取（百度网盘不可达、`epochs/` 为空）。当前 `espcn` 模式用占位权重 ≈ 双线性上采样 + 轻度非锐化；接入真实权重只需把 `.pt` 转 JSON 经 `ESPCN_WEIGHTS_URL` 下发，**引擎与接口无需再改**。
- 验证数据来自 SVG fixture；真实拍照文档建议上线前过一遍。
- 全部改动为内容保真式超分（上采样+锐化），不重绘、不串色，配合 `enhance()` 的 OCR 一致性回退，不会交付劣化图。
