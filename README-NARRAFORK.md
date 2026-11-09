# DSH Pet for NarraFork

一只住在 NarraFork 面板里的蓝色大肥鱼。114 段带 alpha 的动画、拖拽甩抛、点击 Q 弹、多只同屏互撞，还会按余额档位演戏。

本包是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DSH / Cordis 插件）的 NarraFork 移植版。**只做插件包，不改动 NarraFork 核心**——所以能力边界由宿主决定，而不是由本插件决定。本文最后一节如实列出因此缺失的功能。

- 插件 id：`cn.mcd7.neglectdream.dsh-pet`
- 版本：`2.0.0`
- 许可证：MIT
- 运行时依赖：无

---

## 1. 安装

需要一个 **管理员** 账号（带 `server` 或 `views` 的插件都属于 `backend` / `frontend` 层级，安装与启用都要求管理员）。

1. 把 `cn.mcd7.neglectdream.dsh-pet-2.0.0.nfplugin` 放进宿主导入目录：

   ```
   <narrafork home>/plugin-imports/
   ```

   默认是 `~/.narrafork/plugin-imports/`（Windows 为 `C:\Users\<你>\.narrafork\plugin-imports\`）。

2. 打开 **设置 → 插件**，点 **安装**，选择该文件名。
3. 在插件列表里 **启用** 它。
4. 打开 **桌宠** 面板（`workspace` / `focus` / `director` 三个界面都可以挂），或从 **设置 → 桌宠设置** 进入配置页。

第一次打开桌宠面板时会跑一次自检，把每一项关键假设的结果列在左上角。全部通过时会显示一句气泡提示并自动收起；有失败项时会一直显示，并把失败项写进插件 stderr。

---

## 2. 怎么玩

| 操作 | 效果 |
|---|---|
| 拖拽 | 抓住它移动；松手会继承甩出的速度，撞到边界反弹 |
| 单击 | 随机播一段「点击回应」+ 挤压回弹（可开音效） |
| 在 320 ms 内连点两下 | 弹弓：向上弹飞 |
| 右键 | 菜单：换个动作 / 刷新余额 / 睡觉|叫醒 / 全部复位 / 桌宠设置 / 自检信息 |
| 什么都不做 | 每隔几秒随机抽一个动作：转向、走动、小动作、玩耍、吃东西、时节限定 |

「睡觉」是三段式：`睡觉-开始` → `睡觉-循环`（循环直到叫醒）→ `睡觉-起来`。

---

## 3. 余额显示

配置路径：**桌宠设置 → 余额**。两种来源，默认第一种。

### 3.1 跟随 NarraFork 中转站余额（默认，零配置）

NarraFork 自己已经在查中转站（`sub2api` / `new-api`）的余额，并缓存在：

```
<narrafork home>/provider-balances.json
```

桌宠直接读这份缓存，**不需要再填一次密钥**。数字与「供应商设置」里看到的一致；如果宿主那边还没点过「查询余额」，这里会显示「宿主没有可用的中转站余额」。

宿主没有把余额暴露成插件查询（公共查询只有 7 个，没有余额；`config.get` 只返回 provider 配置；`secrets.get` 只读插件自己的命名空间），所以这是唯一不重复要密钥的路径。代价是它依赖宿主的一个内部文件结构：

- 只读、只有一个文件、里面是金额与单位，没有密钥；
- 每个字段都校验，结构不认识时降级为「宿主余额不可用」并给出原因，**不会猜数字**；
- 插件其它功能都不依赖它，宿主改结构只会让余额动画失效，不影响桌宠本体。

百分比口径（与下面的手动来源共用同一套）：

- `total` + `remaining` 齐全 → `(total − remaining) / total`
- 只有 `used` + `remaining` → `used / (used + remaining)`
- 只有 `remaining` 的裸钱包 → 按参照额折算（`CNY` 20 / `USD` 5），因为档位动画需要一个「额度算多少」的基准
- `unlimited` → 0%，永远不会触发「余额告急」
- 多个中转站被跟踪时，取**最吃紧**的那个驱动动画，气泡里写明金额

### 3.2 手动配置服务商

适合宿主不跟踪的服务（DeepSeek 官方 API Key、自建接口）。内置三个适配器 + 一个自定义接口：

| providerId | 读取的接口 | 凭据 |
|---|---|---|
| `deepseek-official` | `GET https://api.deepseek.com/user/balance` | `deepseekApiKey` |
| `opencode-zen` | `GET https://opencode.ai/zen/go/v1/usage` | `opencodeZenApiKey` |
| `commandcode` | `GET https://api.commandcode.ai/alpha/*`（whoami → credits → subscriptions → usage/summary） | `commandCodeApiKey` |
| `custom` | 你填的任意 GET/POST + 字段路径 | `customApiKey` |

**档位**：按「已用百分比」每 20% 一档，共 6 档，恰好 100% 时是第 6 档（`余额-分文不剩`）。档位变化时才播一次动画并冒泡，不是每次轮询都播。

**百分比的来源**（不同形态语义不同，都写在后端一处）：

- `money`（账户余额）：每个币种按自己的参照额折算剩余比例后相加——CNY 对照 20、USD 对照 5。不引入汇率。
- `windows`（三窗口用量）：取三个窗口里最紧张的那个。
- `points`（只有一个剩余数）：**给不出百分比，就不播档位动画**，只显示剩余值。不替服务商猜一个上限。

**密钥**：存在宿主 secret vault 里，插件只能读写自己命名空间下的键。写入后界面只显示「已配置」，任何界面都不会回显明文——宿主对 iframe 的 `secrets.get` 要求管理员会话，所以设置页只写不读。

**刷新节奏**：`pet-state` 是唯一的数据入口，桌宠面板每 12 秒轮询一次，后端发现余额快照超过「查询周期」才真的发请求。面板不可见时轮询停摆（见第 5 节）。失败不会静默：错误分类为 `missing_secret` / `auth_failed` / `network` / `http` / `shape_mismatch`，气泡里显示的是具体原因。

> 与原版的差异：原版在一个请求里做 1s/4s/16s 三次退避重试。这里一次调用只尝试一次——UI 到后端的桥接超时是 10 秒，21 秒的退避必然先超时。重试改由「下一次轮询」承担，失败则如实显示。

---

## 4. 设置项

| 分区 | 内容 |
|---|---|
| 宠物 | 数量 1–6、体型 40%–240%、自动漫游、互相碰撞、是否默认展开自检 |
| 动画 | 10 个分组各自开关（待机/转向/被拖拽/点击回应/移动/小动作/玩耍/吃什么/时节/文字）、两次随机动作的等待区间 |
| 物理 | 重力、弹性、摩擦、点击压扁强度 |
| 音效 | 开关与音量（音效以 base64 内联，用 WebAudio 解码） |
| 余额 | 服务商、查询周期、立即查询、自定义接口、密钥写入/清除 |
| 关于 | 版本、降级清单、数据位置 |

改动自动保存（420 ms 防抖），保存后以**后端返回的配置**为准回填——被夹取的值会立刻在界面上跳回来，而不是看起来生效了、重开面板才发现没生效。

---

## 5. 能力与边界

### 5.1 宿主实际强制了什么

| 项 | 宿主的做法 | 对本插件的影响 |
|---|---|---|
| UI 沙箱 | `sandbox="allow-scripts"`，不透明源 | 没有 cookie、没有 localStorage、没有宿主 DOM |
| iframe CSP | `script-src <origin>`、`img-src <origin> data: blob:`、`font-src <origin>`、`connect-src 'none'`、`media-src 'none'` | **不能 `fetch`、不能 `<video>/<audio>`、不能加载外链字体**；所有表现只能走 `<img>` 与 WebAudio |
| UI → 自己的后端 | 只能 `commands.execute(<裸 id>)`，命令输出上限 2 MiB、桥接超时 10 s | 全部数据面收敛成 7 个命令 |
| 面板选择器按界面过滤 **作用域** | `PluginContributionPicker.tsx` 的 `SURFACE_ALLOWED_SCOPES`：`focus` 只收 `global`/`narrator`，`workspace`/`director` 只收 `global`/`workspace`，`settings` 只收 `global` | 两个视图都用 `scope: "global"` —— 这是唯一在四个界面上都会出现的取值。用 `workspace` 会让桌宠在「叙述者专注视图」里根本不出现（插件看着正常，却无可打开项） |
| 桥接参数校验 | `asset-shell.ts` 的 `validJson` 会把**存在但为 `undefined`** 的键判为非法，请求在到达宿主前就被拒（`Plugin UI params must be JSON`） | `SDK.call(id)` 一律补 `{}`，日志上报也不会带 `detail: undefined` |
| `config.get` | 只返回 provider config，无 provider 的插件拿到 `{}` | 设置存在插件自己的 storage 里，`contributes.configuration` 故意不声明 |
| storage scope | 非 `global` 作用域必须匹配宿主绑定的上下文 id，后端绑定为 `{}` | 只能用 `scope: { type: "global" }`（storage 本身已按插件隔离） |
| 资源路由 | **只服务 manifest 声明过的路径**（`ui.entry`、各视图的 `entry`/`style`、主题图片）；其它路径即使在同一 token 前缀下也是 404。`Cache-Control: private, no-store`；MIME 表有 `.webp` 无 `.webm` | 入口 JS 与 CSS 走资源路由；**114 段动画走命令通道**（`pet-clip` 分片 → `blob:` URL），因为把它们声明进 manifest 需要伪造一百多个视图 |
| 包限额 | 归档 100 MiB / 解包 500 MiB / 单文件 50 MiB；UI 资源单文件 10 MiB | 动画预算 84 MiB，实际 74.74 MiB |
| 后端进程 | `local-process` runner，只过滤 env 与限流，**没有网络沙箱** | 见 5.2 |

### 5.2 `permissions.network` 只是声明，不是沙箱

manifest 里写了 `allow: [...]`，但宿主**不读取**这个字段（`manifest.ts` 的 `uninspectedPermissionSchema` 注释明确说明了这一点：本地进程 runner 继承宿主的完整网络栈）。本插件的后端确实只会访问上表列出的地址，自定义服务商会访问你填的 URL——但这是代码的自觉，不是宿主的强制。真正的网络隔离需要 Podman runner。

同理 `permissions.filesystem` / `permissions.process` 也是声明性质的。

### 5.3 相比 dsh-pet 原版**没有**的功能

| 缺失 | 原因 |
|---|---|
| 全屏置顶浮层 / 桌面级漫游 | 宿主只有 `workspace`/`director`/`focus`/`settings`/`provider-settings` 五个 surface，桌宠被限制在面板矩形内 |
| 系统托盘、多显示器、DPI 适配 | 没有 Electron |
| `<video>` / `<audio>` 播放 | iframe 的 `media-src` 为 `'none'` |
| 语音合成 / 语音识别 | 宿主没有对应 API，且音频本来也播不出来 |
| LLM 碎碎念 / 对话 / 人设 / 记忆 / 配图 | **本版不实现**（范围决策）。事件池 `whisper` 已随包但不播放 |
| 工作状态联动（六档动画 + 状态气泡） | **本版不实现**。宿主有 `narrator.tool.changed` 等事件，后续可接；动画 `工作状态-*` 已随包 |
| 待办事项与到期提醒 | **本版不实现** |
| DSH 账号登录方式的余额 | 没有可借用的凭据服务，只能用 API Key |
| 原版的 39 个 HTTP 端点 / `petApi7340` Cordis 服务 | 改成 7 个 `commands`；第三方调用方需要改为调用这些命令 |
| 原版的 GIF 预览集（67 MB） | 只随包一段探针 GIF，用于验证通道；动画本身用 WebP |
| 自定义字体（`上首软糖体.ttf`，4 MB） | 资源路由的 MIME 表没有 `.ttf`，且响应带 `nosniff`，字体加载会被拒 |

### 5.4 已知限制

- **动画是 10 fps / 384 px 宽**。这是体积与观感的折中：114 段 × 10 秒素材在原始分辨率下转 WebP 会超过 100 MB 上限三倍以上。实测体积几乎正比于 `fps × 宽度²`，质量参数几乎无影响。想换档位可以重跑 `PET_ANIM_BUDGET_MB=... node tools/transcode.mjs`。
- **alpha 是源素材自带的软边**：解码后约 83% 的像素 alpha 落在 0–31（近乎全透明），平均 alpha 0.17，与源 webm 的平均 alpha 0.16 一致。这是素材本身的柔性遮罩，不是转码引入的雾化；ffmpeg 的 `libwebp_anim` 也没有暴露 alpha 压缩参数可以调。
- **切换动画时不会重新下载**：动画数据由后端按 512 KiB 分片经命令通道送出，前端拼成 `blob:` URL 并缓存最近 24 段（约 16 MiB）。同一段再次播放是零成本的，因此宿主资源路由的 `no-store` 对动画不再生效。
- **但第一段要等一次往返**：首次播放某段动画需要 1–3 次 RPC（每段 0.6–1.5 MiB，base64 后约 683 KB/片），本机实测约 40–80 ms。之后从缓存取。
- **动画 WebP 没有播放结束事件**，时长在构建期写进内联索引；运行期的兜底解析器只在索引缺字段时才用。
- **余额请求不走宿主代理**：插件进程的 env 被过滤，`HTTPS_PROXY` 传不进来，`fetch` 也不会读系统代理。
- **面板很小的时候宠物会显得局促**：舞台坐标系就是面板矩形。建议给桌宠一个独立的 panel group，或至少 400×240。

---

## 6. 数据、卸载与清理

配置与余额快照都存在插件 storage：

```
<narrafork home>/plugins/data/cn.mcd7.neglectdream.dsh-pet/
```

卸载插件**默认保留**这些数据，便于重装后恢复。要彻底清除，删除上面这个目录即可。密钥存在宿主的 secret vault（按插件 id 命名），卸载时由宿主撤销。

---

## 7. 从源码构建

需要 Node ≥ 20 与 `ffmpeg`（带 `libvpx-vp9` 解码与 `libwebp_anim` 编码）。构建只需要 ffmpeg 在**这台构建机**上，装插件的机器不需要。

```bash
cd narrafork

node tools/probe.mjs         # 探测 114 段源 webm → anim/sources.json
node tools/transcode.mjs     # 预算驱动转码 → anim/webp/*.webp + anim/files.json
node tools/build-index.mjs   # 从 assets/config.jsonc 推导分组 → anim/index.json
node tools/build-ui.mjs      # 内联索引/音效 → ui/*.iife.js
node tools/verify.mjs        # 静态校验 + 体积报告
node tools/pack.mjs          # → ../dist/cn.mcd7.neglectdream.dsh-pet-2.0.0.nfplugin
```

`tools/transcode.mjs` 的档位是常量表，`--measure` 只测体积不写产物，`--profile=r3a` 可以强制某一档，`PET_ANIM_BUDGET_MB` 改预算，`PET_TRANSCODE_JOBS` 改并发。测量结果有磁盘缓存，反复调参不会重复编码。

产物布局：

```
manifest.json
server/            RPC 骨架、配置、余额（纯 node/bun 内置模块）
ui/*.iife.js       单文件 UI（stage 用原生 DOM，settings 借用宿主 React）
ui/*.css
anim/webp/*.webp   114 段带 alpha 的动画 WebP
anim/index.json    运行期不读它——它被内联进 stage.iife.js，随包只为可审计
assets/            探针 GIF/PNG
tools/             构建脚本（不随包分发）
```

### 构建期验证（三层，都能在本地跑）

```bash
node tools/selftest-server.mjs   # 以模拟宿主的身份驱动真实 RPC：握手/生命周期/7 个命令/错误分类/密钥不外泄
node tools/verify.mjs            # manifest 静态校验（含 cross-field 规则）、资源存在性、索引与 WebP 字节一致性、明文凭据扫描
node tools/preview.mjs           # 起一个本地预览宿主，把 stage.iife.js 放进真实浏览器跑
```

`selftest-server.mjs` 覆盖 44 项断言，包括「无效密钥不得被当成 0%」「`secrets` 列表不含明文」「`storage` 作用域必须是 global」。

`preview.mjs` 是在真浏览器里跑的：它用一份与宿主同形的 `globalThis.narrafork` 桩加载与线上完全相同的 IIFE 包，因此能验证到 WebP 解码、alpha 通道、物理、指针交互、右键菜单、睡觉三段式、余额档位动画，以及「舞台不可见时 rAF 停止」。它复现不了的是宿主 CSP、资源 token URL 与真实桥接——那三项由面板内的自检负责。
