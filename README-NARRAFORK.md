# DSH Pet for NarraFork

一只**浮在 NarraFork 整个界面之上**的蓝色大肥鱼。114 段带 alpha 的动画、拖拽甩抛、点击 Q 弹与独立气泡、多只同屏身体碰撞，还会按余额档位演戏。

2.0 起宠物走宿主的 `overlay` 表面——覆盖全视口、默认点击穿透的透明图层，不再是面板里的一小块。面板模式仍然可用（宿主不支持该表面时会自动退回去）。

本包是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DSH / Cordis 插件）的 NarraFork 移植版。**只做插件包，不改动 NarraFork 核心**——所以能力边界由宿主决定，而不是由本插件决定。本文最后一节如实列出因此缺失的功能。

- 插件 id：`cn.mcd7.neglectdream.dsh-pet`
- 版本：`2.2.0`
- 许可证：代码 MIT；`anim/` 下的动画素材为 CC BY-NC-SA 4.0（见仓库 README 的「许可与署名」）
- 运行时依赖：无

---

## 1. 安装

需要一个 **管理员** 账号（带 `server` 或 `views` 的插件都属于 `backend` / `frontend` 层级，安装与启用都要求管理员）。

1. 把 `cn.mcd7.neglectdream.dsh-pet-2.2.0.nfplugin` 放进宿主导入目录：

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
| 单击 | 点击回应与挤压回弹；气泡按余额 → 随机文案 → 关闭（有分页时先推进该页） |
| 连点 | 不再弹飞；仅可选 home 模式中 320ms 内双击关闭气泡，让保持型浮层也能关闭 |
| 点气泡可见形状 | 面板中推进内容；透明角落穿透。浮层气泡不新增命中区，用点宠物推进 |
| 右键 | 菜单：换个动作 / 刷新余额 / 睡觉\|叫醒 / 全部复位 / 桌宠设置 / 自检信息（**仅面板模式**） |
| 什么都不做 | 每隔几秒随机抽一个动作：转向、走动、小动作、玩耍、吃东西、时节限定 |

「睡觉」是三段式：`睡觉-开始` → `睡觉-循环`（循环直到叫醒）→ `睡觉-起来`。

---

## 3. 余额显示

配置路径：**桌宠设置 → 余额 API**。余额仅来自用户配置的一个第三方 HTTPS API；没有 NarraFork 自动来源、host provider 列表、叙述者绑定或跨服务商轮播。

### 3.1 配置单一余额 API

在设置页填写 HTTPS URL、一个 API Key、`totalPath`（必填）、`usedPath`（可选）、刷新周期与单位。插件固定发起 `GET`，通过 `Authorization: Bearer` 携带 Key；不开放请求方法、额外 headers 或供应商选择。URL 禁止内嵌凭据与非 HTTPS scheme，响应重定向会被拒绝。

- `totalPath` 表示当前剩余余额；`usedPath` 若填写且响应提供有效数值，会额外显示 API 返回的已用数值。插件不展示赠金、充值、总额或推算百分比。缺字段/结构不符时明确显示不可用，不造零值。
- 单位由用户显式选择。`POINTS`/未知单位只显示 API 数值，不推断货币预算或百分比；选择受支持的 ISO 货币后，才将余额下降写入该货币的观测账本。API 没返回已用量时不推算额度百分比。
- Key 写入插件 secret vault 的 `customApiKey`，设置页只显示是否已配置、不回显。Key 不进入 URL、日志或普通配置。旧版 provider key 不自动转移；新版不读取、不删除旧 provider key。
- 请求失败不会把余额设为 0。完全相同的 URL、字段路径、单位、Key 指纹和统计时区可显示最后一次成功样本并标记 stale；更换配置会创建隔离的账户上下文。
- 账本保留历史记录与校正；`POINTS` 不参与货币账本/预算。旧的宿主余额来源、provider/narrator 绑定和相关配置仅在升级时给出一次迁移提示，不再参与余额显示。
- API Key 不要放进 URL。插件后端运行在 local-process 中，直接使用宿主网络栈访问设置的 endpoint；manifest 的 network allowlist 不是宿主强制网络沙箱，后端限制请求时长、响应体大小并拒绝重定向。

---

## 4. 设置项

| 分区 | 内容 |
|---|---|
| 宠物 | 数量 1–6、体型 40%–240%、自动漫游、互相碰撞、是否默认展开自检 |
| 动画 | 10 个分组各自开关（待机/转向/被拖拽/点击回应/移动/小动作/玩耍/吃什么/时节/文字）、两次随机动作的等待区间 |
| 物理 | 重力、弹性、摩擦、点击压扁强度；连续点击不发射，抓取立即打断漫游 |
| 音效 | 原版橡皮鸭叫，默认开启、音量 60%，音量范围 0–100%；仅面板内真实点击可解锁 |
| 余额 API | 单一 HTTPS URL、API Key、查询周期、字段路径与单位；不设多服务商/host 来源切换 |
| 关于 | 版本、降级清单、数据位置 |

改动自动保存（420 ms 防抖），保存后以**后端返回的配置**为准回填——被夹取的值会立刻在界面上跳回来，而不是看起来生效了、重开面板才发现没生效。

---

## 5. 能力与边界

### 5.1 宿主实际强制了什么

| 项 | 宿主的做法 | 对本插件的影响 |
|---|---|---|
| UI 沙箱 | `sandbox="allow-scripts"`，不透明源 | 没有 cookie、没有 localStorage、没有宿主 DOM |
| iframe CSP | `script-src <origin>`、`img-src <origin> data: blob:`、`font-src <origin>`、`connect-src 'none'`、`media-src 'none'` | **不能 `fetch`、不能 `<video>/<audio>`、不能加载外链字体**；所有表现只能走 `<img>` 与 WebAudio |
| UI → 自己的后端 | 只能 `commands.execute(<裸 id>)`，命令输出上限 2 MiB、桥接超时 10 s | 余额 API 使用单个固定命令；所有后端命令共 10 个 |
| 面板选择器按界面过滤 **作用域** | `PluginContributionPicker.tsx` 的 `SURFACE_ALLOWED_SCOPES`：`focus` 只收 `global`/`narrator`，`workspace`/`director` 只收 `global`/`workspace`，`settings` 只收 `global` | 两个视图都用 `scope: "global"` —— 这是唯一在四个界面上都会出现的取值。用 `workspace` 会让桌宠在「叙述者专注视图」里根本不出现（插件看着正常，却无可打开项） |
| 桥接参数校验 | `asset-shell.ts` 的 `validJson` 会把**存在但为 `undefined`** 的键判为非法，请求在到达宿主前就被拒（`Plugin UI params must be JSON`） | `SDK.call(id)` 一律补 `{}`，日志上报也不会带 `detail: undefined` |
| `config.get` | 只返回 provider config，无 provider 的插件拿到 `{}` | 设置存在插件自己的 storage 里，`contributes.configuration` 故意不声明 |
| storage scope | 非 `global` 作用域必须匹配宿主绑定的上下文 id，后端绑定为 `{}` | 只能用 `scope: { type: "global" }`（storage 本身已按插件隔离） |
| 资源路由 | **只服务 manifest 声明过的路径**（`ui.entry`、各视图的 `entry`/`style`、主题图片）；其它路径即使在同一 token 前缀下也是 404。`Cache-Control: private, no-store`；MIME 表有 `.webp` 无 `.webm` | 入口 JS 与 CSS 走资源路由；**114 段动画走命令通道**（`pet-clip` 分片 → `blob:` URL），因为把它们声明进 manifest 需要伪造一百多个视图 |
| 包限额 | 归档 100 MiB / 解包 500 MiB / 单文件 50 MiB；UI 资源单文件 10 MiB | 动画预算 84 MiB，实际 74.74 MiB |
| 后端进程 | `local-process` runner，只过滤 env 与限流，**没有网络沙箱** | 见 5.2 |

### 5.2 `permissions.network` 只是声明，不是沙箱

manifest 里写了 `allow: [...]`，但宿主**不读取**这个字段（`manifest.ts` 的 `uninspectedPermissionSchema` 注释明确说明了这一点：本地进程 runner 继承宿主的完整网络栈）。本插件的余额后端只会访问设置页配置的唯一 HTTPS endpoint；这是代码约束，不是宿主强制。真正的网络隔离需要 Podman runner。

同理 `permissions.filesystem` / `permissions.process` 也是声明性质的。

### 5.3 相比 dsh-pet 原版**没有**的功能

| 缺失 | 原因 |
|---|---|
| 桌面级漫游 / 透明置顶小窗 | 没有 Electron。2.0 起宠物可借 `overlay` 表面浮在**整个页面**之上，但仍限制在浏览器窗口内 |
| 浮层点击音效与本插件的右键菜单 | 当前宿主浮层只转发指针通知，不构成 iframe 内的真实用户激活，无法可靠解锁 `AudioContext`，也不产生 `contextmenu`。**已恢复面板原版鸭叫**（来源见主 README），默认开启；浮层主动无声降级，不排队补播。右键菜单仍只在面板模式可用 |
| 系统托盘、多显示器、DPI 适配 | 没有 Electron |
| `<video>` / `<audio>` 播放 | iframe 的 `media-src` 为 `'none'` |
| 语音合成 / 语音识别 | 宿主没有对应 API；恢复点击音效不代表支持语音服务 |
| LLM 碎碎念 / 对话 / 人设 / 记忆 / 配图 | **本版不实现**（范围决策）。事件池 `whisper` 已随包但不播放 |
| 任务状态提示 | 2.1 接入 UI bridge 的限定范围事件，显示授权等待/完成/错误，不自动调度整套工作动画；不读取会话正文。缺接口、缺权限或失同步时清除不可信等待并独立降级 |
| 等待回答与逐轮费用 | 当前核实的公开宿主不提供可靠提问挂起信号或逐轮 cost/token。保留明确标为模拟的模板预览，不把 waiting、工具运行、余额差当作真实逐轮数据 |
| 待办事项与到期提醒 | **本版不实现** |
| 宿主账号自动余额 | 宿主没有公开给插件的余额 API；本插件只通过用户配置的第三方 HTTPS API 查询 |
| 原版的 39 个 HTTP 端点 / `petApi7340` Cordis 服务 | 改成 10 个 `commands`；第三方调用方需要改为调用这些命令 |
| 原版的 GIF 预览集（67 MB） | 只随包一段探针 GIF，用于验证通道；动画本身用 WebP |
| 自定义字体（`上首软糖体.ttf`，4 MB） | 资源路由的 MIME 表没有 `.ttf`，且响应带 `nosniff`，字体加载会被拒 |

### 5.4 已知限制

- **动画是 10 fps / 384 px 宽**。这是体积与观感的折中：114 段 × 10 秒素材在原始分辨率下转 WebP 会超过 100 MB 上限三倍以上。实测体积几乎正比于 `fps × 宽度²`，质量参数几乎无影响。想换档位可以重跑 `PET_ANIM_BUDGET_MB=... node tools/transcode.mjs`。
- **alpha 是源素材自带的软边**：解码后约 83% 的像素 alpha 落在 0–31（近乎全透明），平均 alpha 0.17，与源 webm 的平均 alpha 0.16 一致。这是素材本身的柔性遮罩，不是转码引入的雾化；ffmpeg 的 `libwebp_anim` 也没有暴露 alpha 压缩参数可以调。
- **缓存内的动画不重复请求**：后端按 512 KiB 分片经命令通道送出，前端缓存最近 24 段原始字节（约 16 MiB）。每次单次播放创建独立 `blob:` URL，结束切换、取消、销毁时回收；连续点击同一段、不同宠物播放同一段不会共用播放时钟。
- **但第一段要等一次往返**：首次播放某段动画需要 1–3 次 RPC（每段 0.6–1.5 MiB，base64 后约 683 KB/片），本机实测约 40–80 ms。之后从缓存取。
- **动画 WebP 没有播放结束事件**，时长由构建期索引提供，在图像解码显示后才计时。单次播放只修改缓存副本的 WebP `ANIM.loopCount=1`，待机/拖拽/睡眠循环用 0；不改写随包源媒体。动作结束后重新抽取完整等待区间。
- **命中与物理分开**：离线扫描全部帧 alpha≥32，加 2px 安全边距。待机命中宽为画布约 38.8%；文字和道具影响相应片段的命中范围，但不撑大身体碰撞。点击挤压只改变绘制与命中，不把身体从墙边推走。
- **浮层仍只有一个命中矩形**：外扩由 60px 收紧到 6px，但两只分开时联合矩形内部的背景仍会被宿主截获。插件不能事后将真实点击穿透给宿主底下的控件；本次没有修改宿主。
- **气泡不驱动物理**：每宠独立场景/代次/绝对截止时间；经典 SVG 与文字分层，主体以可见身体宽约 1.35 倍为目标，低于可读下限或小视口时分页降级。面板仅命中实际 SVG 绘制形状；浮层完全展示层，不扩大宿主 setBounds。
- **静态文案不是 AI 回复**：固定来源迁移 50 条默认记录（49 种原文、样式变体保留）、5 条历史补充、21 个系统模板，另记录 6 项排除。随机池可编辑纯文本和权重；历史/系统模板只读预览，费用/回答等待示例始终标模拟。
- **音效来源与校验**：`assets/sound/click-duck.wav` 原样恢复自 `PC2005-cloud/dsh-pet` 的同名上游素材（`dsh-pet/assets/sound/click-duck.wav`），30,514 字节，Git blob SHA-1 `1f63b736f8589bdc8c2341ff1d4c5557bc663a61`；沿用上游素材署名与许可。构建时内联进舞台，不使用 `<audio>`、外部资源请求或系统播放命令。
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

本目录已包含 WebP、索引与边界数据。普通 UI 修复只需 Node ≥ 20，不需要 ffmpeg、Pillow 或本目录未随附的原版 `assets/config.jsonc`：

```bash
node tools/build-ui.mjs          # 内联索引、边界、原版音效 → ui/*.iife.js
node tools/selftest-stage.mjs    # 受控时钟/随机数/图像延迟的舞台回归
node tools/selftest-server.mjs   # 服务端配置与 RPC 回归
node tools/verify.mjs            # 检查源码/产物一致性、元数据与素材
```

只有更换动画后才需重新生成边界：`python tools/measure-bounds.py`（需 Pillow；只读取素材，不重编码），`python tools/measure-bounds.py --check` 可重测并核对现有数据。生成完再运行 `build-ui`。若要从原始 WebM 重新转码，才需要原版素材、`assets/config.jsonc` 与带 `libvpx-vp9`/`libwebp_anim` 的 ffmpeg，依次使用 `probe.mjs`、`transcode.mjs`、`build-index.mjs`、`measure-bounds.py`。

本次修复没有发布或安装。需要归档时可另行运行 `node tools/pack.mjs`；不要把旧归档当作已更新的源码产物。

产物布局：

```
manifest.json
server/            RPC 骨架、配置、余额（纯 node/bun 内置模块）
ui/*.iife.js       单文件 UI（stage 用原生 DOM，settings 借用宿主 React）
ui/*.css
anim/webp/*.webp   114 段带 alpha 的动画 WebP
anim/index.json    运行期不读它——它被内联进 stage.iife.js，随包只为可审计
anim/bounds.json   所有帧的可见边界、待机身体基准与已确认素材朝向
assets/sound/      原版 click-duck.wav（构建时内联，不依赖媒体资源路由）
tools/             构建脚本（不随包分发）
```

### 构建与回归验证（均可本地运行）

```bash
node tools/selftest-server.mjs   # 以模拟宿主的身份驱动真实 RPC：握手/生命周期/10 个命令/错误分类/密钥不外泄
node tools/verify.mjs            # manifest 静态校验（含 cross-field 规则）、资源存在性、索引与 WebP 字节一致性、明文凭据扫描
node tools/preview.mjs           # 起一个本地预览宿主，把 stage.iife.js 放进真实浏览器跑
```

`selftest-server.mjs` 覆盖 63 项断言，包括音效旧配置兼容与限幅、密钥不外泄、storage global 作用域。`selftest-stage.mjs` 覆盖新增宠物、随机等待、异步取消与 URL 释放、朝向、抓放、连点、紧凑体框、气泡以及音频超时降级。替身测试不等于真实图像解码或扬声器试听。

`preview.mjs` 是在真浏览器里跑的：它用一份与宿主同形的 `globalThis.narrafork` 桩加载与线上完全相同的 IIFE 包，因此能验证到 WebP 解码、alpha 通道、物理、指针交互、右键菜单、睡觉三段式、余额档位动画，以及「舞台不可见时 rAF 停止」。预览支持 `?surface=overlay&count=2&idleMinMs=4000&idleMaxMs=9000&clipDelayMs=300`、动画分组与 `window.__preview` 控制入口，命令响应按真实 RPC 复制；浮层模拟现有通知和 `setBounds`，可区分宠物、联合矩形死区、外部背景。它不模拟宿主 CSP、资源 token、sandbox 权限或真实扬声器听感，不能替代在实际宿主的验收。

## 8. 2.2 气泡、单一余额 API 与观测账本

- 气泡设置提供总开关、0.75–1.4 相对大小、普通/提醒停留时间（0 为保持）、推进/home 模式、自动闲聊和原版样式预览；最小字号 12px，极小宠物或小视口会分页降级。
- **余额来源固定为一个用户配置的第三方 API**：设置页输入 HTTPS URL、一个 API Key、查询周期与响应字段路径；固定 GET + Bearer。不再读取 NarraFork 的 `provider-balances.json`，不读取对话 context/log，也没有 provider/narrator 绑定或多服务商轮播。API Key 只保存在插件自己的 secret vault 槽位 `customApiKey`，UI 只显示是否配置；旧版本内置 provider key 不迁移、不删除、不再读取。
- `totalPath` 指 API 返回的当前剩余数，`usedPath` 可选；气泡只显示该 API 返回的剩余值及配置了 `usedPath` 时的已用值，不显示赠金、充值、额度总额或推算百分比。币种/单位由用户设置：`POINTS`/未知单位只显示数值，不做货币账本或金额预算；明确选择支持的货币后才记录该币种的余额下降观测。
- 请求失败不会伪造成零余额；只有同 URL、字段路径、单位、key 和统计时区完全一致时才复用旧值并标 stale。更换 endpoint/key/字段/单位会建立新账户上下文，避免跨服务/币种混账。
- 插件 local-process 直接请求设置的 HTTPS URL。manifest 的网络字段不构成宿主强制网络沙箱；不要将 API Key 放进 URL。后端拒绝重定向、限制响应字节与请求时限，但本地进程仍使用宿主网络栈。
- 账本仅写插件 global storage 的 `pet.accounting.v1`，使用 8 位定点、按 API/key/币种/时区隔离；下降与上涨分别累计，不把余额上涨自动认定充值，不冒充完整服务商账单。跨日/长采样缺口保留为未分配观测；校正要求当前 revision 和明确确认，支持有限审计与撤销，损坏时保留原值并停止写入。
- 金额预算与余额预警默认关闭；预算仅适用于明确配置货币的当前 API 账户。余额迟滞、预算按统计日/规则版本闩锁。通知使用 60 秒租约，按当前 API active account IDs 领取且展示后 ack；旧 API 账户的历史 ledger/提醒不串入当前预算视图。同一后端进程内串行；storage 没有跨进程 CAS，因此不承诺多个独立后台进程 exactly-once。
- 统计时区默认本机时区；更改时区会分开账户/统计口径。账本限制 32 个账户、每账户 31 日摘要/16 条审计、64 条待通知、128 个闩锁、总计 768 KiB。
- **不会读取日志里最近实际调用的模型/供应商**：宿主没有给本插件开放可靠的 last-invocation 字段；余额完全来自此处配置的单一 endpoint，API Key/URL 与当前叙述者无自动关联。
- 任务事件能力保持独立：仅通过公开 UI bridge 的 scope/filter 订阅当前 narrator 或本视图已知 ID；事件缺失/授权不足时只降级任务提醒，不影响余额 API。没有逐轮 cost/token 与可靠提问挂起事件，因此不伪造这两类数据。
- 经典气泡轮廓/文案/配色来源、MIT 署名和未迁移图片/音频资源清单见主 README 与 `ui/bubble-presets.json`。
