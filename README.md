# dsh-pet for NarraFork 🐾

<p align="center">
  <a href="LICENSE"><img alt="code license" src="https://img.shields.io/badge/code-MIT-blue"></a>
  <a href="#许可与署名"><img alt="assets license" src="https://img.shields.io/badge/assets-CC%20BY--NC--SA%204.0-orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-NarraFork-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/animations-114-ff69b4">
</p>

一只浮在 NarraFork 整个界面之上的蓝色大肥鱼：114 段带 alpha 的动画、拖拽甩抛与边界反弹、点击 Q 弹与独立气泡、多只同屏身体碰撞、按余额档位演戏，还能右键点播动作、让它睡觉。

本仓库是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DSH / Cordis 插件）的 **NarraFork 移植版**。原版的动画素材、表现设计与物理手感被完整沿用；**代码是按 NarraFork 的插件 ABI 重写的**，因为两个宿主的运行环境完全不同（NarraFork 的插件 UI 是不透明源 iframe，没有 `fetch`、没有 `<video>`、拿不到宿主 DOM）。

原版最强的地方是「100+ 段动画无缝衔接」和那套甩抛手感——这两样搬过来了。桌面透明窗、语音、LLM 碎碎念那些依赖 Electron 或宿主 API 的部分没有搬，完整差异见 **[README-NARRAFORK.md](README-NARRAFORK.md)** 的 5.3 节。

---

## 快速开始（安装）

需要一个 **管理员** 账号（本插件带后端，属于 `backend` 层级，安装与启用都要求管理员）。

1. 下载发布包 `cn.mcd7.neglectdream.dsh-pet-2.2.0.nfplugin`；
2. NarraFork → 设置 → 插件 → 导入该文件；
3. 启用插件，桌宠出现在界面右下角——**它浮在整个页面之上**，不属于任何面板。

> 想从源码自己构建？见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 7 节：`node tools/build-ui.mjs` → `node tools/verify.mjs` → `node tools/pack.mjs`。

## 插件功能

只做桌宠本身，不碰 NarraFork 内核。

- **114 段透明动画**：待机、转向、走动、小动作、玩耍、吃东西、时节限定、点击回应、被拖拽、文字，共 10 个分组，每次动作结束后按设置的区间随机等待，期间保留待机呼吸；前端缓存最近 24 段原始字节，单次播放使用独立时钟，重复播放无需再次请求后端。
- **浮在整个界面之上**：走 NarraFork 的 `overlay` 表面——一个覆盖全视口、默认点击穿透的透明图层。插件上报可见范围的紧凑联合矩形，矩形外可以正常点滚。宿主只支持一个矩形，因此多只分开时中间的空白仍可能拦截点击。
- **交互与物理**：单击或连续点击只播放回应、挤压回弹和气泡，不再双击发射。抓取立即打断漫游；甩出按近期指针速度计算，停住后轻放不沿用旧速度。重力 / 弹性 / 摩擦 / 压扁强度均可调。
- **紧凑命中与碰撞**：完整绘制动画，命中范围来自各片段所有帧的可见边界；身体互撞使用稳定的待机主体，不被文字、道具或挤压特效撑大。待机命中宽约为原画布的 38.8%。
- **原版鸭叫**：面板内真实点击可播放原版橡皮鸭音效，默认开启、音量 60%，可关闭；当前宿主浮层仅中继指针，无法可靠解锁音频，浮层不播放也不积压声音。
- **多开与体型**：同时养 1–6 只，独立位置、场景和点击序列，体型可调 35%–300%，可以互相碰撞或自动漫游。
- **睡觉**：右键「睡觉」，三段式（开始 → 循环 → 起来），睡着时完全安静，点一下或右键叫醒。
- **经典气泡**：固定参考 MeteorNOX 的白底蓝边、两颗小泡泡与分段展开；点击宠物按余额 → 随机文案 → 关闭推进，长内容先分页。气泡从可见身体框定比例，小体型保留可读下限，浮层不因此扩大命中矩形。
- **余额展示**：只查询设置中填写的一个第三方 HTTPS API URL 与 API Key，不读取 NarraFork 对话上下文、日志或宿主余额缓存。响应字段路径和单位由用户设置；缺字段、未知单位或查询失败不会伪造成 0。Key 使用宿主 Secret Vault 保存、只写不回显。
- **观测记账与预算**：8 位定点记录余额下降、上涨，区分账户与统计时区；跨日和长缺口不冒充完整今日账单。支持明确确认的修正和撤销、默认关闭的余额/预算预警、持久领取确认去重。
- **限范围任务提醒**：仅关联宿主当前叙述者或本视图手填 ID，支持公开事件中的授权等待、完成和错误。缺事件接口或授权时独立降级；宿主未提供逐轮费用及可靠等待回答信号，设置中只提供明确标注的示例。
- **右键菜单**（仅面板内）：换个动作、刷新余额、睡觉 / 叫醒、全部复位、桌宠设置、自检信息。浮层模式下 iframe 点击穿透、输入靠宿主中继，右键不弹菜单——差异与原因见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 5.3 节。
- **对外接口**：后端声明 10 个命令，含状态、配置、余额、动画分片、密钥状态、日志及账本读取/校正/提醒领取确认；不提供绕过权限的任务操作。

各项设置（数量 / 体型 / 动画分组 / 音效 / 物理 / 余额）见 [README-NARRAFORK.md](README-NARRAFORK.md) 第 4 节。

## 兼容性

- **宿主**：NarraFork ≥ 0.9.12，且需要支持 `overlay` 表面（该表面由 [NarraFork #pet-overlay] 分支引入）。宿主不支持时插件仍可装在面板里用，只是宠物被限制在面板矩形内。
- **浏览器**：动画是 **动画 WebP**，Chrome / Edge / Firefox / Safari 14+ 均可直接播放——原版用 VP9-alpha webm，Safari 透明会变黑底，本移植版不存在这个问题。
- **体积**：归档 74.87 MiB（宿主上限 100 MiB），其中动画 74.78 MiB。动画是 10 fps / 384 px 宽的折中档位，换档位可重跑 `tools/transcode.mjs`。
- **网络**：余额查询由插件后端直连服务商，不走宿主代理（插件进程的 env 被宿主过滤，`HTTPS_PROXY` 传不进去）。

## 项目结构

```
├── manifest.json          # 插件清单：设置视图 + 舞台（面板/浮层）+ 10 个命令
├── server/                # 后端：配置、余额、命令分发、动画分片下发
├── ui/                    # 前端：stage（宠物舞台）与 settings（设置页），打包成单文件 IIFE
├── anim/                  # 114 段动画 WebP + 内联索引（构建期写入时长与体积）
├── tools/                 # 构建链：transcode / build-index / build-ui / verify / pack / selftest
├── README-NARRAFORK.md    # 宿主适配细节：能力边界、缺失清单、已知限制、从源码构建
├── sbom.spdx.json         # 依赖清单（运行时零依赖）
└── LICENSE                # 代码 MIT；anim/ 下的素材为 CC BY-NC-SA 4.0，见下
```

## 许可与署名

- **代码**：MIT（见 [LICENSE](LICENSE)）。经典气泡轮廓、配色与文案迁自 `MeteorNOX/DeepSeek-Balance-Whale-Widget@5247dd6813d6e4430728f39ccc63d43cda046022`，保留 Copyright (c) 2026 MeteorNOX；来源与逐项排除记录见 `ui/bubble-presets.json` 和 `tools/bubble-source-audit.json`。不包含参考项目的 GIF、PNG、声音或字体资源，MIT 代码许可不扩展到其美术素材。
- **动画素材**（`anim/` 下的 WebP 帧）：派生自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，**不是 MIT**，而是 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)（署名 · **非商业** · 相同方式共享）。
- **点击音效来源**：[assets/sound/click-duck.wav](assets/sound/click-duck.wav) 恢复自上游 `PC2005-cloud/dsh-pet` 的 `dsh-pet/assets/sound/click-duck.wav`，保留原始 30,514 字节，未合成或转码；Git blob SHA-1 为 `1f63b736f8589bdc8c2341ff1d4c5557bc663a61`。素材沿用上游署名与许可，不因内联进代码而改为 MIT。
- **二创约定**：基于本项目的衍生 / 改版 / 换皮作品，在 GitHub 仓库、产品官网等公开渠道上须附上原作者仓库地址 <https://github.com/PC2005-cloud/dsh-pet>。
- **形象出处**：宠物形象为社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），**非 DeepSeek 官方形象**；原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版（女仆鲸鱼娘）设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)。
- **形象授权**：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，[声明原文](https://www.bilibili.com/opus/1247156596114456581)：「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」

> 换句话说：代码你可以随便用；**形象与动画不能商用**，且改版必须以同样协议开放。

## 相关链接

- 原项目与动画素材来源：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（提示词配方、素材生成链、GIF 预览都在那边）
- 宿主：[NarraFork](https://github.com/NeglectDream/NarraFork) —— 本移植依赖的 `overlay` 表面由该分支引入
