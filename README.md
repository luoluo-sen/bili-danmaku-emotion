# Bilibili 弹幕情绪时间序列（Qwen Embedding, MV3 扩展）

抓取当前 B 站 `bilibili.com/video/*` 页弹幕，在后台调用 SiliconFlow 的 Qwen3 Embedding 模型，对弹幕做**零样本情绪归类**（基于嵌入相似度），再按时间窗口聚合并用 ECharts 渲染**情感强度随时间**的曲线与样本数柱状图。

## 功能

- 一键从视频页抓取整段弹幕（XML，含秒级时间戳）。
- 后台请求 SiliconFlow Embeddings（默认 `Qwen/Qwen3-Embedding-8B`，4096 维，32K 上限）。
- 通过标签原型（开心/感动/生气/…）的嵌入相似度做零样本情绪分类。
- 时间段聚合（默认 30s）+ 简单平滑，ECharts 可视化。

## 安装（开发者模式）

1. 打开 Chrome/Edge，进入 `chrome://extensions`。
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录。
4. 在扩展“详细信息”里打开“扩展选项”，填入 SiliconFlow API Key，保存。

## 使用

1. 打开任意 B 站视频页面，例如 `https://www.bilibili.com/video/BV...`。
2. 右下角会出现“分析弹幕（Qwen Embedding）”浮动面板。
3. 点击按钮：
   - 获取 `cid` → 拉取弹幕 XML → 远端生成嵌入 → 零样本情绪分类 → 时间聚合 → 绘图。
4. 首次批量请求会稍慢；可在选项页调整“批大小/采样上限/时间粒度”。


```

## 选项说明

- SiliconFlow API Key：用于调用 `https://api.siliconflow.cn/v1/embeddings`。
- Embedding 模型：默认 `Qwen/Qwen3-Embedding-8B`（可切换为 4B/0.6B 或 BGE）。
- 维度：Qwen3 支持多种维度，默认 4096。
- 批大小：每次请求嵌入的条数，默认 64。
- 采样上限：每个视频最多处理的弹幕条数，默认 4000。
- 时间聚合粒度：折线图的时间 bin（秒），默认 30。
注：具体的维度大小要遵循所选模型数，如图所示。

<img width="2794" height="1341" alt="image" src="https://github.com/user-attachments/assets/501394dd-bbac-4dfc-b571-e7d421cfb50f" />

## 实现要点

- 跨域接口放在 `background.js`：
  - `x/player/pagelist?bvid=...` 获取 `cid`。
  - `x/v1/dm/list.so?oid=cid` 拉取弹幕 XML。
  - `POST /v1/embeddings` 调用 SiliconFlow（存储中读取 API Key）。
- `content.js`：页面注入 UI，触发分析，解析 XML，调用后台分批嵌入，基于标签原型做相似度分类，时间聚合后发布到页面。
- `injected.js`：页面上下文加载 ECharts，监听 `postMessage` 并渲染图表。

## 情绪分类（零样本）

通过为每个情绪标签定义一个中文**原型描述句**（如“这条弹幕表达了开心、快乐、愉快的情绪。”），计算其嵌入；再对每条弹幕求与各标签嵌入的余弦相似度，取最大者为类别。最终将类别映射到[-1, +1]的情感强度，并用“前二者相似度间隔”作为置信度调整强度幅度。

> 若需替换为**本地 Transformer 情感模型**或**远端情感分类 API**，只需在 `content.js` 更换分类逻辑即可。

## 常见问题

- 没有曲线/错误提示“缺少 API Key”：请在插件“选项”中填写 SiliconFlow Key。
- 请求速率限制：默认每批后 `100ms` 间隔；可在 `options` 调整批大小或采样上限。
- ECharts 未加载：页面 CSP 正常情况下不影响注入；若主题脚本冲突，刷新重试。

## 后续优化

- 加入“代表弹幕/Top 关键词”列表，提升可解释性。
- 细粒度情绪标签可在选项中增删并自动缓存标签嵌入。
- 支持分 P 视频按当前 P 获取对应 cid。
