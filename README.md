# dsh-pet for NarraFork 🐾

<p align="center">
  <a href="LICENSE"><img alt="code license" src="https://img.shields.io/badge/code-MIT-blue"></a>
  <a href="#许可与署名"><img alt="assets license" src="https://img.shields.io/badge/assets-CC%20BY--NC--SA%204.0-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-NarraFork-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/animations-114-ff69b4">
</p>

一只浮在 NarraFork 整个界面之上的蓝色大肥鱼：114 段带 alpha 的动画、拖拽甩抛与边界反弹、点击 Q 弹、双击弹弓、多只同屏互撞、按余额档位演戏，还能右键点播动作、让它睡觉。

本仓库是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DSH / Cordis 插件）的 **NarraFork 移植版**。原版的动画素材、表现设计与物理手感被完整沿用；**代码是按 NarraFork 的插件 ABI 重写的**，因为两个宿主的运行环境完全不同（NarraFork 的插件 UI 是不透明源 iframe，没有 `fetch`、没有 `<video>`、拿不到宿主 DOM）。

原版最强的地方是「100+ 段动画无缝衔接」和那套甩抛手感——这两样搬过来了。桌面透明窗、语音、LLM 碎碎念那些依赖 Electron 或宿主 API 的部分没有搬，完整差异见 **[README-NARRAFORK.md](README-NARRAFORK.md)** 的 5.3 节。

---

## 快速开始（安装）

需要一个 **管理员** 账号（本插件带后端，属于 `backend` 层级，安装与启用都要求管理员）。

1. 下载发布包 `cn.mcd7.neglectdream.dsh-pet-2.0.0.nfplugin`；
2. NarraFork → 设置 → 插件 → 导入该文件；
3. 启用插件，桌宠出现在界面右下角——**它浮在整个页面之上**，不属于任何面板。

> 想从源码自己构建？见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 7 节：`node tools/build-ui.mjs` → `node tools/verify.mjs` → `node tools/pack.mjs`。

## 插件功能

只做桌宠本身，不碰 NarraFork 内核。

- **114 段透明动画**：待机、转向、走动、小动作、玩耍、吃东西、时节限定、点击回应、被拖拽、文字，共 10 个分组，按权重首尾相接随机抽播，同一段重复播放是零成本的（前端缓存最近 24 段）。
- **浮在整个界面之上**：走 NarraFork 的 `overlay` 表面——一个覆盖全视口、默认点击穿透的透明图层。宠物可以出现在屏幕任何位置，而页面照常能点能滚。
- **交互与物理**：单击随机播一段「点击回应」并挤压回弹；320 ms 内连点两下弹弓上飞；拖拽甩抛，松手继承速度、撞边界反弹；重力 / 弹性 / 摩擦 / 压扁强度都可调。
- **多开与体型**：同时养 1–6 只，各自位置与体型（40%–240%），可以互相碰撞，也可以开着自动漫游让它们自己逛。
- **睡觉**：右键「睡觉」，三段式（开始 → 循环 → 起来），睡着时完全安静，点一下或右键叫醒。
- **余额展示**：默认直接读 NarraFork 已缓存的中转站余额（不用再填一次密钥）；也可手动登记服务商 / 自定义接口。按剩余额度分档播动画。
- **右键菜单**（仅面板内）：换个动作、刷新余额、睡觉 / 叫醒、全部复位、桌宠设置、自检信息。浮层模式下 iframe 点击穿透、输入靠宿主中继，右键不弹菜单——差异与原因见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 5.3 节。
- **对外接口**：后端暴露 7 个命令，别的插件或脚本可以让它说一句、播一段指定动画、读它当前状态。

各项设置（数量 / 体型 / 动画分组 / 物理 / 余额）见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 4 节。

## 兼容性

- **宿主**：NarraFork ≥ 0.9.12，且需要支持 `overlay` 表面（该表面由 [NarraFork #pet-overlay] 分支引入）。宿主不支持时插件仍可装在面板里用，只是宠物被限制在面板矩形内。
- **浏览器**：动画是 **动画 WebP**，Chrome / Edge / Firefox / Safari 14+ 均可直接播放——原版用 VP9-alpha webm，Safari 透明会变黑底，本移植版不存在这个问题。
- **体积**：归档 74.87 MiB（宿主上限 100 MiB），其中动画 74.78 MiB。动画是 10 fps / 384 px 宽的折中档位，换档位可重跑 `tools/transcode.mjs`。
- **网络**：余额查询由插件后端直连服务商，不走宿主代理（插件进程的 env 被宿主过滤，`HTTPS_PROXY` 传不进去）。

## 项目结构

```
├── manifest.json          # 插件清单：1 个 settings 视图 + 1 个 overlay 视图 + 7 个命令
├── server/                # 后端：配置、余额、命令分发、动画分片下发
├── ui/                    # 前端：stage（宠物舞台）与 settings（设置页），打包成单文件 IIFE
├── anim/                  # 114 段动画 WebP + 内联索引（构建期写入时长与体积）
├── tools/                 # 构建链：transcode / build-index / build-ui / verify / pack / selftest
├── README-NARRAFORK.md    # 宿主适配细节：能力边界、缺失清单、已知限制、从源码构建
├── sbom.spdx.json         # 依赖清单（运行时零依赖）
└── LICENSE                # 代码 MIT；anim/ 下的素材为 CC BY-NC-SA 4.0，见下
```

## 许可与署名

- **代码**：MIT（见 [LICENSE](LICENSE)）。
- **动画素材**（`anim/` 下的 WebP 帧）：派生自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**不是 MIT**，而是 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名 · **非商业** · 相同方式共享）。
- **二创约定**：基于本项目的衍生 / 改版 / 换皮作品，在 GitHub 仓库、产品官网等公开渠道上须附上原作者仓库地址 <https://github.com/PC2005-cloud/dsh-pet>。
- **形象出处**：宠物形象为社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），**非 DeepSeek 官方形象**；原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版（女仆鲸鱼娘）设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)。
- **形象授权**：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，[声明原文](https://www.bilibili.com/opus/1247156596114456581)：「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」

> 换句话说：代码你可以随便用；**形象与动画不能商用**，且改版必须以同样协议开放。

## 相关链接

- 原项目与动画素材来源：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（提示词配方、素材生成链、GIF 预览都在那边）
- 宿主：[NarraFork](https://github.com/NeglectDream/NarraFork) —— 本移植依赖的 `overlay` 表面由该分支引入
