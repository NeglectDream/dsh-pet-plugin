/**
 * Settings panel — the only place the pet can be configured.
 *
 * WHY THIS VIEW OPTED INTO `runtime: "host-react"`
 * The stage deliberately avoids React: it is a render loop, and a virtual DOM
 * between the loop and six `<img>` elements buys nothing. This panel is the exact
 * opposite — a dozen switches, sliders and password fields per section — and the
 * host already ships React + Mantine (with its own theme tokens) as a shared
 * runtime the shell injects *before* this file. Using it costs this package
 * nothing and gives the panel the host's real components instead of a
 * hand-rolled lookalike.
 *
 * HOW A CHANGE REACHES THE STAGE
 * The stage polls `pet-state` every 12 s and every change here is written through
 * `pet-config-set`, which the backend validates and clamps, then echoes back. The
 * panel saves what the backend *returned*, not what was typed, so a clamped value
 * snaps back in the UI immediately instead of looking applied until reload.
 */

const runtime = globalThis.__nfPluginRuntime;
const mount = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));

if (!runtime) {
	// A readable failure beats a blank panel: the shell's own splash is removed as
	// soon as this script loads, so silence would look like a rendering bug.
	mount.innerHTML =
		'<div style="padding:16px;font:13px/1.6 system-ui;color:#fa5252">' +
		"桌宠设置需要宿主 React 运行时，但 globalThis.__nfPluginRuntime 不存在。" +
		"<br>请确认 manifest 中该视图声明了 runtime: \"host-react\"。" +
		"</div>";
	throw new Error("host-react runtime is unavailable");
}

const { React, MantineCore: M } = runtime;
const h = React.createElement;

/* -------------------------------------------------------------------------- */
/* Small building blocks                                                      */
/* -------------------------------------------------------------------------- */

function Section({ title, description, children }) {
	return h(
		M.Card,
		{ withBorder: true, padding: "md", radius: "md" },
		h(
			M.Stack,
			{ gap: "sm" },
			h(
				"div",
				null,
				h("div", { style: { fontWeight: 600, fontSize: 13 } }, title),
				description
					? h("div", { style: { fontSize: 11.5, opacity: 0.65, lineHeight: 1.5 } }, description)
					: null,
			),
			children,
		),
	);
}

function Toggle({ label, description, checked, onChange, disabled }) {
	return h(
		M.Group,
		{ justify: "space-between", wrap: "nowrap", align: "flex-start" },
		h(
			"div",
			{ style: { flex: "1 1 auto" } },
			h("div", { style: { fontSize: 12.5 } }, label),
			description
				? h("div", { style: { fontSize: 11, opacity: 0.6, lineHeight: 1.45 } }, description)
				: null,
		),
		h(M.Switch, { checked: Boolean(checked), onChange: (event) => onChange(event.currentTarget.checked), disabled }),
	);
}

function SliderRow({ label, value, min, max, step, onChange, format }) {
	return h(
		"div",
		null,
		h(
			M.Group,
			{ justify: "space-between", mb: 4 },
			h("span", { style: { fontSize: 12.5 } }, label),
			h(M.Text, { size: "xs", c: "dimmed" }, format ? format(value) : String(value)),
		),
		h(M.Slider, { value, min, max, step, onChange, label: format ? format : undefined }),
	);
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

const GROUP_LABELS = {
	idle: ["待机", "呼吸、漂浮等静息动作"],
	turn: ["转向", "东张西望，播完翻转朝向"],
	drag: ["被拖拽", "被抓起悬空时的姿势"],
	click: ["点击回应", "点一下它时随机播放"],
	move: ["移动", "会真的走到别处的动作"],
	small: ["小动作", "伸懒腰、打哈欠一类"],
	play: ["玩耍", "玩具、乐器、舞蹈"],
	eat: ["吃什么", "各种吃"],
	season: ["时节", "节日与季节限定"],
	text: ["文字", "画面上带文字，宠物朝左时不播"],
};

const FIELD_HELP = {
	count: "同时出现几只（1–6），每只独立运动、互相碰撞",
	scale: "相对面板宽度的体型倍数",
	gravity: "越大掉得越快；0 会飘起来",
	bounce: "碰到边界反弹的强度",
	friction: "落地后滑行的阻力",
	clickSquash: "点一下被压扁的程度",
	idleMinMs: "两次随机动作之间最短的等待",
	idleMaxMs: "最长等待",
};

function App() {
	const [config, setConfig] = React.useState(undefined);
	const [warnings, setWarnings] = React.useState([]);
	const [status, setStatus] = React.useState("loading");
	const [providers, setProviders] = React.useState([]);
	const [secrets, setSecrets] = React.useState([]);
	const [balanceBusy, setBalanceBusy] = React.useState(false);
	const [balanceResult, setBalanceResult] = React.useState(undefined);
	const [draftSecret, setDraftSecret] = React.useState({});
	const [tab, setTab] = React.useState("pet");
	const saveTimer = React.useRef(0);
	const pendingSave = React.useRef(undefined);
	// `commit` needs the newest config synchronously. Reading it from a ref rather
	// than from the state updater keeps the debounce scheduling out of render-phase
	// code, where a double-invoked updater would arm the timer twice.
	const configRef = React.useRef(undefined);
	configRef.current = config;

	const loadSecrets = React.useCallback(async () => {
		const result = await SDK.callSafe("pet-secrets-list");
		if (result.ok) setSecrets(result.value?.keys ?? []);
	}, []);

	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			const configResult = await SDK.callSafe("pet-config-get");
			if (cancelled) return;
			if (!configResult.ok) {
				setStatus(`error: ${configResult.error.message}`);
				return;
			}
			setConfig(configResult.value.config);
			setWarnings(configResult.value.warnings ?? []);
			const providerResult = await SDK.callSafe("pet-balance-providers");
			if (!cancelled && providerResult.ok) setProviders(providerResult.value?.providers ?? []);
			await loadSecrets();
			if (!cancelled) setStatus("ready");
		})();
		return () => {
			cancelled = true;
		};
	}, [loadSecrets]);

	/**
	 * Debounced write-through.
	 *
	 * Every control knows the whole config, so the patch is always the full object;
	 * the backend deep-merges and clamps. Debouncing keeps dragging a slider from
	 * generating one storage write per pixel.
	 */
	const commit = React.useCallback((patch) => {
		const previous = configRef.current;
		if (!previous) return;
		const next = { ...previous, ...patch };
		configRef.current = next;
		setConfig(next);
		pendingSave.current = patch;
		clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(async () => {
			const toSave = pendingSave.current;
			pendingSave.current = undefined;
			setStatus("saving");
			const result = await SDK.callSafe("pet-config-set", { patch: toSave });
			if (!result.ok) {
				setStatus(`error: ${result.error.message}`);
				return;
			}
			setConfig(result.value.config);
			configRef.current = result.value.config;
			setWarnings(result.value.warnings ?? []);
			setStatus("saved");
			setTimeout(() => setStatus((current) => (current === "saved" ? "ready" : current)), 1400);
		}, 420);
	}, []);

	const saveSecret = async (secretKey) => {
		const value = (draftSecret[secretKey] ?? "").trim();
		if (!value) return;
		try {
			await SDK.bridge().secrets.set(secretKey, value);
			setDraftSecret((previous) => ({ ...previous, [secretKey]: "" }));
			await loadSecrets();
			setBalanceResult({ tone: "ok", text: "密钥已保存（不会回显）" });
		} catch (error) {
			setBalanceResult({ tone: "error", text: `保存失败：${error?.message ?? error}` });
		}
	};

	const clearSecret = async (secretKey) => {
		try {
			await SDK.bridge().secrets.delete(secretKey);
			await loadSecrets();
			setBalanceResult({ tone: "ok", text: "密钥已删除" });
		} catch (error) {
			setBalanceResult({ tone: "error", text: `删除失败：${error?.message ?? error}` });
		}
	};

	const testBalance = async () => {
		setBalanceBusy(true);
		setBalanceResult(undefined);
		const result = await SDK.callSafe("pet-balance-refresh", { force: true });
		setBalanceBusy(false);
		if (!result.ok) {
			setBalanceResult({ tone: "error", text: result.error.message });
			return;
		}
		const snapshot = result.value?.snapshot;
		if (!snapshot) {
			setBalanceResult({ tone: "warn", text: "没有启用的余额服务商" });
			return;
		}
		if (!snapshot.ok) {
			setBalanceResult({ tone: "error", text: `${snapshot.error?.message ?? "查询失败"}` });
			return;
		}
		setBalanceResult({
			tone: "ok",
			text: `${snapshot.summary} · 已用 ${Math.round(snapshot.percent ?? 0)}% · 档位 ${snapshot.tier}`,
		});
	};

	if (status.startsWith("error")) {
		return h(
			M.Container,
			{ size: "sm", py: "md" },
			h(M.Alert, { color: "red", title: "桌宠设置无法加载" }, status.slice("error:".length).trim()),
			h(
				M.Text,
				{ size: "xs", c: "dimmed", mt: "sm" },
				"如果桌宠面板能正常打开，多半是后端进程没有激活；打开一次「桌宠」面板即可。",
			),
		);
	}
	if (!config) {
		return h(
			M.Center,
			{ style: { minHeight: 200 } },
			h(M.Stack, { align: "center", gap: "xs" }, h(M.Loader, { size: "sm" }), h(M.Text, { size: "xs", c: "dimmed" }, "读取配置…")),
		);
	}

	const patchBalance = (patch) => commit({ balance: { ...config.balance, ...patch } });
	const patchBalanceCustom = (patch) =>
		commit({ balance: { ...config.balance, custom: { ...config.balance.custom, ...patch } } });
	const animationGroups = config.animationGroups ?? {};
	const providerOptions = providers.map((provider) => ({
		value: provider.id,
		label: provider.label,
	}));

	return h(
		M.Container,
		{ size: "sm", py: "md" },
		h(
			M.Stack,
			{ gap: "sm" },
			h(
				M.Group,
				{ justify: "space-between" },
				h(
					"div",
					null,
					h("div", { style: { fontWeight: 650, fontSize: 15 } }, "桌宠设置"),
					h(
						M.Text,
						{ size: "xs", c: "dimmed" },
						status === "saving" ? "保存中…" : status === "saved" ? "已保存" : "改动会自动保存",
					),
				),
				h(
					M.Group,
					{ gap: "xs" },
					h(
						M.Button,
						{
							variant: "subtle",
							size: "xs",
							onClick: () => {
								commit({});
							},
						},
						"重新读取",
					),
					h(
						M.Button,
						{
							variant: "subtle",
							color: "red",
							size: "xs",
							onClick: async () => {
								const result = await SDK.callSafe("pet-config-set", { reset: true });
								if (result.ok) {
									setConfig(result.value.config);
									setWarnings(result.value.warnings ?? []);
								}
							},
						},
						"恢复默认",
					),
				),
			),

			warnings.length > 0
				? h(
						M.Alert,
						{ color: "yellow", title: "有字段被调整", p: "xs" },
						h(
							M.Stack,
							{ gap: 2 },
							...warnings.map((warning, index) => h(M.Text, { key: index, size: "xs" }, warning)),
						),
					)
				: null,

			h(
				M.Tabs,
				{ value: tab, onChange: (value) => setTab(value ?? "pet"), variant: "outline" },
				h(
					M.Tabs.List,
					null,
					h(M.Tabs.Tab, { value: "pet" }, "宠物"),
					h(M.Tabs.Tab, { value: "anim" }, "动画"),
					h(M.Tabs.Tab, { value: "physics" }, "物理"),
					h(M.Tabs.Tab, { value: "balance" }, "余额"),
					h(M.Tabs.Tab, { value: "about" }, "关于"),
				),

				/* ---------------------------------------------------- 宠物 */
				h(
					M.Tabs.Panel,
					{ value: "pet", pt: "sm" },
					h(
						M.Stack,
						{ gap: "sm" },
						h(
							Section,
							{ title: "数量与体型", description: "改动立刻生效，不需要重开面板。" },
							h(SliderRow, {
								label: "同时出现",
								value: config.count,
								min: 1,
								max: 6,
								step: 1,
								onChange: (value) => commit({ count: value }),
								format: (value) => `${value} 只`,
							}),
							h(SliderRow, {
								label: "体型",
								value: config.scale,
								min: 0.4,
								max: 2.4,
								step: 0.05,
								onChange: (value) => commit({ scale: value }),
								format: (value) => `${Math.round(value * 100)}%`,
							}),
							h(M.Text, { size: "xs", c: "dimmed" }, `${FIELD_HELP.count}；${FIELD_HELP.scale}`),
						),
						h(
							Section,
							{ title: "行为", description: "关掉自动漫游后，它只会待在原地做小动作。" },
							h(Toggle, {
								label: "自动漫游",
								description: "随机挑选「移动」类动作并走到面板的另一处",
								checked: config.roam,
								onChange: (value) => commit({ roam: value }),
							}),
							h(Toggle, {
								label: "互相碰撞",
								description: "多只宠物会互相挤开，而不是重叠在一起",
								checked: config.collisions,
								onChange: (value) => commit({ collisions: value }),
							}),
						),
						h(
							Section,
							{ title: "舞台提示", description: "自检面板会列出启动时的每一项检查结果。" },
							h(Toggle, {
								label: "打开面板时显示自检信息",
								checked: config.diagnostics,
								onChange: (value) => commit({ diagnostics: value }),
							}),
						),
					),
				),

				/* ---------------------------------------------------- 动画 */
				h(
					M.Tabs.Panel,
					{ value: "anim", pt: "sm" },
					h(
						M.Stack,
						{ gap: "sm" },
						h(
							Section,
							{
								title: "动作分组",
								description: "关掉的分组不会再被随机抽到；「被拖拽」「点击回应」「余额」始终可用。",
							},
							...Object.entries(GROUP_LABELS).map(([group, [label, description]]) =>
								h(Toggle, {
									key: group,
									label,
									description,
									checked: animationGroups[group] !== false,
									onChange: (value) =>
										commit({
											animationGroups: { ...animationGroups, [group]: value },
										}),
								}),
							),
						),
						h(
							Section,
							{ title: "节奏", description: "两次随机动作之间的等待区间，单位毫秒。" },
							h(SliderRow, {
								label: "最短等待",
								value: config.idleMinMs,
								min: 800,
								max: 20_000,
								step: 200,
								onChange: (value) => commit({ idleMinMs: value }),
								format: (value) => `${(value / 1000).toFixed(1)} 秒`,
							}),
							h(SliderRow, {
								label: "最长等待",
								value: config.idleMaxMs,
								min: 1000,
								max: 60_000,
								step: 500,
								onChange: (value) => commit({ idleMaxMs: value }),
								format: (value) => `${(value / 1000).toFixed(1)} 秒`,
							}),
						),
					),
				),

				/* ---------------------------------------------------- 物理 */
				h(
					M.Tabs.Panel,
					{ value: "physics", pt: "sm" },
					h(
						Section,
						{ title: "手感", description: "默认值来自原版 dsh-pet，先改一点点试试。" },
						h(SliderRow, {
							label: "重力",
							value: config.gravity,
							min: 0,
							max: 3,
							step: 0.05,
							onChange: (value) => commit({ gravity: value }),
							format: (value) => `${value.toFixed(2)}×`,
						}),
						h(SliderRow, {
							label: "弹性",
							value: config.bounce,
							min: 0,
							max: 0.95,
							step: 0.01,
							onChange: (value) => commit({ bounce: value }),
							format: (value) => `${Math.round(value * 100)}%`,
						}),
						h(SliderRow, {
							label: "摩擦",
							value: config.friction,
							min: 0.5,
							max: 0.995,
							step: 0.005,
							onChange: (value) => commit({ friction: value }),
							format: (value) => value.toFixed(3),
						}),
						h(SliderRow, {
							label: "点击压扁",
							value: config.clickSquash,
							min: 0,
							max: 1,
							step: 0.02,
							onChange: (value) => commit({ clickSquash: value }),
							format: (value) => `${Math.round(value * 100)}%`,
						}),
						h(M.Text, { size: "xs", c: "dimmed" }, FIELD_HELP.friction),
					),
				),

				/* ---------------------------------------------------- 余额 */
				h(
					M.Tabs.Panel,
					{ value: "balance", pt: "sm" },
					h(
						M.Stack,
						{ gap: "sm" },
						h(
							Section,
							{
								title: "余额来源",
								description:
									"按已用百分比分成六档，每档对应一段动画。默认直接使用 NarraFork 已经查到的中转站余额，不需要在这里再填一次密钥。",
							},
							h(M.SegmentedControl, {
								fullWidth: true,
								data: [
									{ value: "host", label: "跟随 NarraFork 中转站" },
									{ value: "manual", label: "手动配置服务商" },
								],
								value: config.balance.source ?? "host",
								onChange: (value) => patchBalance({ source: value }),
							}),
							h(
								M.Text,
								{ size: "xs", c: "dimmed" },
								(config.balance.source ?? "host") === "host"
									? "读取宿主缓存的 sub2api / new-api 中转站余额。数字与供应商设置页看到的一致；宿主那边点过「查询余额」后这里才有数据。"
									: "由本插件自己请求服务商的余额接口，需要单独填 API Key。适合宿主不跟踪的服务（例如 DeepSeek 官方 API Key）。",
							),
							h(SliderRow, {
								label: "查询周期",
								value: config.balance.refreshMinutes,
								min: 1,
								max: 240,
								step: 1,
								onChange: (value) => patchBalance({ refreshMinutes: value }),
								format: (value) => `${value} 分钟`,
							}),
							h(
								M.Group,
								{ gap: "xs" },
								h(
									M.Button,
									{
										size: "xs",
										onClick: testBalance,
										loading: balanceBusy,
										disabled: (config.balance.source ?? "host") === "manual" && !config.balance.providerId,
									},
									"立即查询",
								),
								balanceResult
									? h(
											M.Badge,
											{
												color:
													balanceResult.tone === "ok" ? "green" : balanceResult.tone === "warn" ? "yellow" : "red",
												variant: "light",
												style: { textTransform: "none", fontWeight: 400 },
											},
											balanceResult.text,
										)
									: null,
							),
						),

						(config.balance.source ?? "host") === "manual"
							? h(
									Section,
									{
										title: "手动服务商",
										description: "密钥保存在宿主 secret vault 里，插件只能读自己命名空间下的那些。",
									},
									h(M.Select, {
										label: "服务商",
										placeholder: "不启用",
										clearable: true,
										data: providerOptions,
										value: config.balance.providerId,
										onChange: (value) => patchBalance({ providerId: value ?? null }),
									}),
								)
							: null,

						config.balance.providerId === "custom"
							? h(
									Section,
									{
										title: "自定义接口",
										description:
											"适合任何返回 JSON 的余额接口。URL 必须是 http(s)，采用 GET/POST；插件直接发起请求，不经过宿主代理。",
									},
									h(M.TextInput, {
										label: "名称",
										value: config.balance.custom.label,
										onChange: (event) => patchBalanceCustom({ label: event.currentTarget.value }),
									}),
									h(M.TextInput, {
										label: "URL",
										placeholder: "https://example.com/api/balance",
										value: config.balance.custom.url,
										onChange: (event) => patchBalanceCustom({ url: event.currentTarget.value }),
									}),
									h(M.SegmentedControl, {
										data: ["GET", "POST"],
										value: config.balance.custom.method,
										onChange: (value) => patchBalanceCustom({ method: value }),
									}),
									h(M.TextInput, {
										label: "剩余额度字段路径",
										description: "点号分隔，例如 data.balance 或 balance.total",
										value: config.balance.custom.totalPath,
										onChange: (event) => patchBalanceCustom({ totalPath: event.currentTarget.value }),
									}),
									h(M.TextInput, {
										label: "已用额度字段路径（可选）",
										description: "填了就用「已用 ÷(已用+剩余)」算百分比；不填则只显示剩余值，不播档位动画",
										value: config.balance.custom.usedPath,
										onChange: (event) => patchBalanceCustom({ usedPath: event.currentTarget.value }),
									}),
								)
							: null,

						(config.balance.source ?? "host") === "manual"
							? h(
							Section,
							{
								title: "密钥",
								description:
									"写入后只显示「已配置」，任何界面都不会回显明文——宿主对 iframe 的 secrets.get 要求管理员会话，所以这里只写不读。",
							},
							...secrets.map((entry) => {
								const label = entry.key;
								return h(
									M.Group,
									{ key: entry.key, align: "flex-end", wrap: "nowrap" },
									h(M.PasswordInput, {
										label,
										placeholder: entry.configured ? "已配置（输入新值可覆盖）" : "未配置",
										value: draftSecret[entry.key] ?? "",
										onChange: (event) =>
											setDraftSecret((previous) => ({ ...previous, [entry.key]: event.currentTarget.value })),
										style: { flex: "1 1 auto" },
									}),
									h(M.Button, { size: "xs", onClick: () => saveSecret(entry.key) }, "保存"),
									entry.configured
										? h(
												M.Button,
												{ size: "xs", variant: "subtle", color: "red", onClick: () => clearSecret(entry.key) },
												"清除",
											)
										: null,
									h(
										M.Badge,
										{ color: entry.configured ? "green" : "gray", variant: "light" },
										entry.configured ? "已配置" : "未配置",
									),
								);
							}),
						)
							: null,
					),
				),

				/* ---------------------------------------------------- 关于 */
				h(
					M.Tabs.Panel,
					{ value: "about", pt: "sm" },
					h(
						M.Stack,
						{ gap: "sm" },
						h(
							Section,
							{ title: "这是什么" },
							h(
								M.Text,
								{ size: "sm" },
								"DSH Pet 是从 dsh-pet（DSH / Cordis 插件）移植到 NarraFork 的桌宠。动画来自同一套 114 段素材，转码为带 alpha 的动画 WebP 后随包分发。",
							),
						),
						h(
							Section,
							{
								title: "相比原版少了什么",
								description: "每条都是宿主边界造成的，不是没做完：",
							},
							...[ 
								"全屏置顶浮层：宿主只提供 Dockview 面板与设置页，桌宠只能在面板矩形内活动。",
								"系统托盘、多显示器漫游、DPI 适配：没有 Electron。",
								"<video>/<audio> 播放：iframe 的 media-src 为 'none'，所有表现只能走 <img> 与 WebAudio。",
								"语音合成与识别：宿主没有对应 API。",
								"LLM 闲聊与记忆：本次版本不实现，动画与余额是本版的全部内容。",
								"DSH 账号登录方式的余额：没有可借用的凭据服务，只能用 API Key。",
							].map((item, index) => h(M.Text, { key: index, size: "xs", c: "dimmed" }, `· ${item}`)),
						),
						h(
							Section,
							{ title: "数据" },
							h(
								M.Text,
								{ size: "xs", c: "dimmed" },
								"配置与余额快照存在插件自己的 storage（按插件 id 隔离）。卸载插件默认保留这些数据，删除 ~/.narrafork/plugins/data/cn.mcd7.neglectdream.dsh-pet 即可彻底清除。",
							),
						),
					),
				),
			),
		),
	);
}

/* -------------------------------------------------------------------------- */
/* Mount                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shell sets `data-mantine-color-scheme` on `<html>` from the host's scheme
 * and pushes changes as `host.theme` notifications, but Mantine's provider still
 * needs to be told which scheme to use — and told again when the host switches.
 * Mirroring the attribute with a MutationObserver is the smallest way to stay in
 * sync without a second source of truth.
 */
function colorScheme() {
	return document.documentElement.dataset.mantineColorScheme === "light" ? "light" : "dark";
}

function Root() {
	const [scheme, setScheme] = React.useState(colorScheme);
	React.useEffect(() => {
		const observer = new MutationObserver(() => setScheme(colorScheme()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mantine-color-scheme"] });
		return () => observer.disconnect();
	}, []);
	return h(
		M.MantineProvider,
		{
			theme: runtime.theme,
			cssVariablesResolver: M.v8CssVariablesResolver,
			forceColorScheme: scheme,
			colorSchemeManager: {
				get: () => scheme,
				set: () => {},
				subscribe: () => {},
				unsubscribe: () => {},
				clear: () => {},
			},
		},
		h(App),
	);
}

const existing = mount.querySelector("[data-dsh-pet-settings]");
if (existing) existing.remove();
const container = document.createElement("div");
container.dataset.dshPetSettings = "1";
mount.append(container);

runtime.ReactDOMClient.createRoot(container).render(h(Root));
