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

/**
 * Numeric entry that survives an empty field.
 *
 * Mantine's `NumberInput` reports `""` when the user clears it; a controlled value
 * that ignores `""` snaps the old number back mid-edit, so there is no way to
 * select-all and retype. Keeping the draft locally means "empty" is a real,
 * temporary state and only parseable values are written through.
 */
function NumberField({ label, description, value, min, max, onChange, disabled, unit }) {
	const [text, setText] = React.useState(String(value ?? ""));
	const focused = React.useRef(false);
	React.useEffect(() => {
		if (!focused.current) setText(String(value ?? ""));
	}, [value]);
	const parsed = /^\d+(?:[.,]\d*)?$/.test(text.trim()) ? Number(text.trim().replace(",", ".")) : null;
	const invalid = parsed !== null && (parsed < min || parsed > max);
	const commit = (next) => {
		if (next === null || !Number.isFinite(next)) return;
		onChange(Math.min(Math.max(next, min), max));
	};
	return h(M.TextInput, {
		label, description, disabled, value: text, inputMode: "decimal",
		rightSection: unit ? h(M.Text, { size: "xs", c: "dimmed" }, unit) : undefined,
		rightSectionWidth: unit ? 40 : undefined,
		error: invalid ? `请输入 ${min}–${max} 之间的数字` : undefined,
		onFocus: () => { focused.current = true; },
		onChange: (event) => {
			const next = event.currentTarget.value;
			setText(next);
			if (/^\d+(?:[.,]\d*)?$/.test(next.trim())) commit(Number(next.trim().replace(",", ".")));
		},
		onBlur: () => {
			focused.current = false;
			const next = /^\d+(?:[.,]\d*)?$/.test(text.trim()) ? Number(text.trim().replace(",", ".")) : null;
			if (next === null || !Number.isFinite(next)) setText(String(value ?? ""));
			else { commit(next); setText(String(Math.min(Math.max(next, min), max))); }
		},
	});
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

/* -------------------------------------------------------------------------- */
/* Shared original bubble renderer, with isolated and visibly simulated data.  */
/* -------------------------------------------------------------------------- */

const SETTINGS_BUBBLE_DEFAULTS = Object.freeze({
	enabled: true, scale: 1, durationMs: 5000, noticeDurationMs: 8000,
	clickMode: "advance", autoChat: true, overrides: [],
});

function bubblePresetGroups() {
	const data = typeof __PET_BUBBLE_PRESETS__ === "object" ? __PET_BUBBLE_PRESETS__ : {};
	return [
		{ id: "random", label: "原版随机文案", description: "同一句话的不同字号、粗体或渐变版本保留独立记录；编辑只改文字与权重。", editable: true, entries: data.random },
		{ id: "history", label: "历史补充文案", description: "保留来源记录，仅供查看与模拟预览；不混入当前默认随机池。", editable: false, entries: data.history },
		{ id: "templates", label: "系统模板（模拟）", description: "用于查看系统消息样式与变量占位。此处的展示不代表真实事件或费用信号已经接入。", editable: false, entries: data.templates },
	].map((group) => ({ ...group, entries: Array.isArray(group.entries) ? group.entries : [] }));
}

function BubblePreview({ entry, scale }) {
	const host = React.useRef(null);
	const bubble = React.useRef(null);
	const [error, setError] = React.useState("");
	const previewConfig = { ...SETTINGS_BUBBLE_DEFAULTS, scale, enabled: true, autoChat: false, durationMs: 0, noticeDurationMs: 0 };
	React.useEffect(() => {
		if (!host.current) return;
		if (typeof PetBubble !== "function") { setError("共享气泡组件未加载；无法展示原版预览。"); return; }
		const element = host.current;
		let observer;
		try {
			const width = Math.max(180, element.clientWidth || 320);
			bubble.current = new PetBubble({
				container: element, body: { left: width / 2 - 80, top: 210, right: width / 2 + 80, bottom: 270, width: 160, height: 60 },
				viewport: { width, height: 300 }, surface: "panel",
				config: previewConfig,
			});
			const resize = () => {
				const nextWidth = Math.max(180, element.clientWidth || 320);
				bubble.current?.position({ left: nextWidth / 2 - 80, top: 210, right: nextWidth / 2 + 80, bottom: 270, width: 160, height: 60 }, { width: nextWidth, height: 300 });
			};
			if (typeof ResizeObserver === "function") { observer = new ResizeObserver(resize); observer.observe(element); }
			setError("");
		} catch (cause) {
			setError(`预览暂不可用：${cause?.message ?? cause}`);
		}
		return () => { observer?.disconnect(); bubble.current?.destroy(); bubble.current = null; };
	}, []);
	React.useEffect(() => {
		if (!bubble.current || !entry) return;
		try {
			bubble.current.setConfig(previewConfig);
			// expiresAt: 0 pairs with durationMs: 0 so the sample persists until replaced.
			bubble.current.show({ ...entry, kind: "text", simulation: true }, { id: `preview-${entry.id}`, priority: 100, durationMs: 0, expiresAt: 0, automatic: false });
			// The panel can still be hidden (display:none) right after mount, where the
			// measured width is 0; the ResizeObserver repositions once it is revealed.
			const width = Math.max(180, host.current?.clientWidth || 320);
			bubble.current.position({ left: width / 2 - 80, top: 210, right: width / 2 + 80, bottom: 270, width: 160, height: 60 }, { width, height: 300 });
		} catch (cause) {
			setError(`预览暂不可用：${cause?.message ?? cause}`);
		}
	}, [entry, scale]);
	return h("div", { className: "pet-settings-preview", "data-simulation": "true" },
		h(M.Group, { justify: "space-between", gap: "xs" },
			h(M.Text, { size: "sm", fw: 600 }, "原版样式预览"),
			h(M.Badge, { color: "orange", variant: "filled" }, "模拟 · 非真实事件"),
		),
		h("div", { className: "pet-settings-preview-stage" },
			h("div", { ref: host, className: "pet-settings-preview-bubbles", "aria-label": "模拟气泡预览" }),
			h("div", { className: "pet-settings-preview-anchor", "aria-hidden": true }, "宠物位置"),
		),
		error ? h(M.Alert, { color: "yellow", p: "xs" }, error) : null,
		h(M.Text, { size: "xs", c: "dimmed" }, "复用舞台 PetBubble 组件。此区域强制可见并保持展示，不请求余额、不订阅任务、不消费提醒，也不会改动气泡总开关。"),
	);
}

function BubblePresetRow({ preset, override, editable, onApply, onReset, onPreview, disabled }) {
	const effectiveText = override?.text ?? preset.text ?? "";
	const effectiveWeight = override?.weight ?? preset.weight ?? 1;
	const [text, setText] = React.useState(effectiveText);
	const [weight, setWeight] = React.useState(effectiveWeight);
	React.useEffect(() => { setText(effectiveText); setWeight(effectiveWeight); }, [effectiveText, effectiveWeight]);
	const dirty = text !== effectiveText || weight !== effectiveWeight;
	const style = preset.style ?? {};
	return h("article", { className: "pet-settings-preset-row" },
		h(M.Group, { justify: "space-between", gap: "xs" },
			h(M.Text, { size: "xs", fw: 600 }, preset.id),
			h(M.Group, { gap: 5 },
				!editable ? h(M.Badge, { color: "gray", size: "xs" }, "只读参考") : null,
				override ? h(M.Badge, { color: "blue", size: "xs" }, "已自定义") : null,
			),
		),
		h(M.Text, { size: "xs", c: "dimmed" }, [
			style.fontSize == null ? "默认字号" : style.fontUnit === "source-level" ? `原版字号档位 ${style.fontSize}/50` : `字号 ${style.fontSize}`,
			style.bold ? "粗体" : "常规",
			style.gradient ? `渐变 ${style.gradient}` : "无渐变",
		].join(" · ")),
		editable ? h(M.Textarea, {
			label: "纯文本文案", value: text, autosize: true, minRows: 2, maxRows: 5, maxLength: 300,
			onChange: (event) => setText(event.currentTarget.value), description: `${text.length}/300 字符；不执行 HTML 或脚本。`,
		}) : h(M.Text, { size: "sm", className: "pet-settings-plain-text" }, effectiveText),
		editable ? h(NumberField, { label: "随机权重", description: "0 不参与自动抽取；越大越容易抽到，同文不同样式分别计权。",
			value: weight, min: 0, max: 100, onChange: setWeight })
			: h(M.Text, { size: "xs", c: "dimmed" }, preset.weight == null ? "系统模板，不参与随机抽取" : `来源权重：${preset.weight}（历史参考，不参与当前默认池）`),
		h(M.Group, { gap: "xs", wrap: "wrap" },
			h(M.Button, { size: "compact-xs", variant: "light", onClick: () => onPreview({ ...preset, text, weight: typeof weight === "number" ? weight : effectiveWeight }) }, "模拟预览"),
			editable ? h(M.Button, { size: "compact-xs", disabled: disabled || !dirty || !text.trim() || typeof weight !== "number",
				onClick: () => onApply({ id: preset.id, text: text.trim(), weight }) }, "应用这条文案") : null,
			editable ? h(M.Button, { size: "compact-xs", variant: "subtle", disabled: !override && !dirty,
				onClick: () => { setText(preset.text ?? ""); setWeight(preset.weight ?? 1); onReset(preset.id); } }, "恢复这条默认") : null,
		),
		editable && disabled && !override ? h(M.Text, { size: "xs", c: "yellow" }, "已达到 120 条自定义记录上限，请先恢复部分默认文案。") : null,
	);
}

function BubbleSettings({ value, onChange }) {
	const settings = { ...SETTINGS_BUBBLE_DEFAULTS, ...value };
	const groups = React.useMemo(bubblePresetGroups, []);
	const [preview, setPreview] = React.useState(() => groups[0].entries[0] ?? { id: "unavailable", text: "尚未载入文案数据", style: {} });
	const [resetOpen, setResetOpen] = React.useState(false);
	const previewContainer = React.useRef(null);
	const choosePreview = (entry) => {
		setPreview(entry);
		previewContainer.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
	};
	const overrides = Array.isArray(settings.overrides) ? settings.overrides : [];
	const knownIds = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.id)));
	const unmatchedCount = overrides.filter((entry) => !knownIds.has(entry.id)).length;
	const updateOverride = (entry) => {
		const exists = overrides.some((item) => item.id === entry.id);
		if (!exists && overrides.length >= 120) return;
		const next = exists ? overrides.map((item) => item.id === entry.id ? entry : item) : [...overrides, entry];
		onChange({ overrides: next });
		setPreview((current) => current?.id === entry.id ? { ...current, ...entry } : current);
	};
	const resetOverride = (id) => {
		onChange({ overrides: overrides.filter((entry) => entry.id !== id) });
		const original = groups.flatMap((group) => group.entries).find((entry) => entry.id === id);
		if (original) setPreview((current) => current?.id === id ? original : current);
	};
	return h(M.Stack, { gap: "sm" },
		h(Section, { title: "气泡显示与交互", description: "气泡设置独立于宠物体型。总开关关闭时不显示气泡；自动闲聊只控制随机文案，不代表接入 LLM。" },
			h(Toggle, { label: "显示气泡", checked: settings.enabled, onChange: (enabled) => onChange({ enabled }) }),
			h(SliderRow, { label: "气泡相对缩放", value: settings.scale, min: 0.75, max: 1.4, step: 0.05,
				onChange: (scale) => onChange({ scale }), format: (scale) => `${Math.round(scale * 100)}%` }),
			h("div", { className: "pet-settings-columns" },
				h(NumberField, { label: "普通气泡停留", description: "0 = 保持显示，直到手动切换或关闭。", unit: "秒",
					value: settings.durationMs / 1000, min: 0, max: 120,
					onChange: (next) => onChange({ durationMs: Math.round(next * 1000) }) }),
				h(NumberField, { label: "提醒气泡停留", description: "0 = 保持显示；真实提醒仍有自己的过期时间。", unit: "秒",
					value: settings.noticeDurationMs / 1000, min: 0, max: 120,
					onChange: (next) => onChange({ noticeDurationMs: Math.round(next * 1000) }) }),
			),
			h(M.Select, { label: "点击气泡", value: settings.clickMode, data: [
				{ value: "advance", label: "顺序切换：余额 → 随机文案 → 关闭" }, { value: "home", label: "返回余额主页" },
			], onChange: (clickMode) => onChange({ clickMode: clickMode || "advance" }) }),
			h(Toggle, { label: "自动闲聊", description: "从原版随机文案池按权重抽取，不调用模型、不产生逐轮费用。",
				checked: settings.autoChat, onChange: (autoChat) => onChange({ autoChat }) }),
		),
		h("div", { ref: previewContainer },
			h(BubblePreview, { entry: preview, scale: settings.scale }),
			h(M.Button, { size: "xs", variant: "subtle", mt: 5, disabled: !preview, onClick: () => setPreview((entry) => entry ? { ...entry } : entry) }, "重新展示当前模拟文案"),
		),
		h(Section, { title: "完整文案库", description: "每条文案保留原版样式。编辑后点击“应用这条文案”；预览始终是模拟，不会冒充真实任务、提问或费用。" },
			h(M.Group, { justify: "space-between" },
				h(M.Text, { size: "xs", c: "dimmed" }, `自定义 ${overrides.length}/120 条${unmatchedCount > 0 ? `（其中 ${unmatchedCount} 条与当前文案库不匹配，不会生效）` : ""}；默认文案来自固定纯数据资源。`),
				h(M.Button, { size: "xs", variant: "subtle", color: "red", disabled: overrides.length === 0, onClick: () => setResetOpen(true) }, "恢复全部默认文案…"),
			),
			...groups.map((group) => h("details", { key: group.id, className: "pet-settings-details", open: group.id === "random" },
				h("summary", null, `${group.label}（${group.entries.length} 条）`),
				h(M.Text, { size: "xs", c: "dimmed", my: "xs" }, group.description),
				group.entries.length === 0 ? h(M.Text, { size: "xs", c: "dimmed" }, "此分组没有可展示的数据。") : null,
				...group.entries.map((preset) => h(BubblePresetRow, {
					key: preset.id, preset, editable: group.editable, override: overrides.find((entry) => entry.id === preset.id),
					disabled: overrides.length >= 120 && !overrides.some((entry) => entry.id === preset.id),
					onApply: updateOverride, onReset: resetOverride, onPreview: choosePreview,
				})),
			)),
		),
		h(M.Modal, { opened: resetOpen, onClose: () => setResetOpen(false), title: "恢复全部默认文案", centered: true },
			h(M.Stack, { gap: "sm" },
				h(M.Text, { size: "sm" }, "只清除文案文字与权重覆盖，不修改气泡开关、停留时间或其他设置。"),
				h(M.Group, { justify: "flex-end" },
					h(M.Button, { size: "xs", variant: "default", onClick: () => setResetOpen(false) }, "取消"),
					h(M.Button, { size: "xs", color: "red", onClick: () => { onChange({ overrides: [] }); setResetOpen(false); setPreview(groups[0].entries[0]); } }, "确认恢复"),
				),
			),
		),
	);
}

/* -------------------------------------------------------------------------- */
/* Observation ledger: never mix accounts, currencies or simulated data.       */
/* -------------------------------------------------------------------------- */

function ledgerAmount(value, currency = "") {
	if (value === null || value === undefined || value === "") return "未知";
	const raw = String(value);
	const readable = /^-?\d+(\.\d+)?$/.test(raw) ? raw.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1") : "未知";
	return `${readable}${currency ? currency === "%" ? "%" : ` ${currency}` : ""}`;
}

function ledgerTime(value, timeZone) {
	if (!value) return "尚无观测";
	try {
		const instant = new Date(value);
		if (!Number.isFinite(instant.getTime())) return "时间未知";
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
		}).format(instant);
	} catch {
		return String(value);
	}
}

function validLedgerDecimal(value) {
	if (typeof value !== "string" || !/^\d{1,20}(?:\.\d{1,8})?$/.test(value.trim())) return false;
	const [whole, fraction = ""] = value.trim().split(".");
	// Match the backend's eight-place fixed-point bound without binary rounding.
	return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function FactGrid({ rows }) {
	return h("dl", { className: "pet-settings-facts" },
		...rows.flatMap(([label, value], index) => [
			h("dt", { key: `label-${index}` }, label),
			h("dd", { key: `value-${index}` }, value ?? "未知"),
		]),
	);
}

function localSettingsTimeZone() {
	try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
	catch { return "UTC"; }
}

function AccountingSettings({ value, onChange }) {
	const timeZone = value?.timeZone ?? localSettingsTimeZone();
	const [draftZone, setDraftZone] = React.useState(timeZone);
	const [zoneError, setZoneError] = React.useState("");
	React.useEffect(() => setDraftZone(timeZone), [timeZone]);
	const applyZone = () => {
		const next = draftZone.trim();
		try {
			new Intl.DateTimeFormat("zh-CN", { timeZone: next }).format();
			if (!next) throw new Error("empty");
			setZoneError("");
			onChange({ timeZone: next });
		} catch {
			setZoneError("请输入有效的 IANA 时区，例如 Asia/Shanghai、UTC 或 America/New_York。");
		}
	};
	return h(Section, {
		title: "统计时区与观测间隔",
		description: "“今日”按以下时区划分。时区变更不保证已有历史样本能重新完整分配；以账本的不完整原因提示为准。",
	},
		h(M.Group, { align: "flex-end", wrap: "wrap" },
			h(M.TextInput, {
				label: "统计时区（IANA）", placeholder: "Asia/Shanghai", value: draftZone,
				onChange: (event) => setDraftZone(event.currentTarget.value), error: zoneError || undefined,
				style: { flex: "1 1 220px" }, maxLength: 80,
			}),
			h(M.Button, { size: "xs", onClick: applyZone, disabled: draftZone === timeZone }, "应用时区"),
		),
		h(NumberField, {
			label: "可接受的最大观测间隔", unit: "分钟",
			description: "超过此间隔仍可看到余额变化，但不能声称是完整的当日费用。",
			value: value?.maxGapMinutes ?? 180, min: 1, max: 1440,
			onChange: (next) => onChange({ maxGapMinutes: Math.round(next) }),
		}),
	);
}

function LedgerCorrection({ account, revision, busy, onCorrect }) {
	const [topUp, setTopUp] = React.useState(account.confirmedTopUp ?? "");
	const [nonUsage, setNonUsage] = React.useState(account.nonUsageDebit ?? "0");
	const [note, setNote] = React.useState("");
	const [noteError, setNoteError] = React.useState("");
	const [confirmed, setConfirmed] = React.useState(false);
	const [undoTarget, setUndoTarget] = React.useState(null);
	const audit = Array.isArray(account.audit) ? account.audit : [];
	const undone = new Set(audit.flatMap((entry) => [entry.undoOf, entry.undoneBy ? entry.id : null]).filter(Boolean));
	const latest = [...audit].reverse().find((entry) => entry.action === "set" && !entry.undoneBy && !undone.has(entry.id));
	const valid = validLedgerDecimal(topUp) && validLedgerDecimal(nonUsage);
	const edit = (setter, value) => { setter(value); setConfirmed(false); setUndoTarget(null); };
	// The backend rejects markup and control characters; strip them as typed so a
	// pasted `<` cannot make the whole correction fail at submit time.
	const editNote = (raw) => {
		edit(setNote, raw.replace(/[<>\u0000-\u001f\u007f]/g, ""));
		setNoteError("");
	};
	const requireNote = () => {
		if (note.trim()) return true;
		setNoteError("必须填写 1–300 字核对说明（纯文本）。");
		return false;
	};
	return h(Section, {
		title: "人工核对与校正",
		description: "填的是该账户整个观测区间的累计到账与非调用扣减，不是本次增量，不会充值、退款或修改服务商余额。",
	},
		h(M.Alert, { color: "yellow", title: "请先核对账户、币种和版本", p: "sm" },
			h(M.Text, { size: "xs" }, `${account.label || account.accountId} · ${account.currency || "未知币种"} · revision ${revision}`),
			h(M.Text, { size: "xs" }, "修正净额 = 期初余额 + 累计到账 − 当前余额 − 非调用扣减。未确认累计到账时修正净额保持未知；校正不会把跨日变化强行分配到今天。"),
		),
		h("div", { className: "pet-settings-columns" },
			h(M.TextInput, {
				label: `累计到账（${account.currency || "币种未知"}）`, description: "包含充值、赠额等已核实入账；确认为零也需明确填 0。",
				value: topUp, inputMode: "decimal", maxLength: 30, disabled: busy,
				onChange: (event) => edit(setTopUp, event.currentTarget.value),
				error: topUp && !validLedgerDecimal(topUp) ? "需为非负金额、最多 8 位小数且不超过 90071992.54740991" : undefined,
			}),
			h(M.TextInput, {
				label: `非调用扣减（${account.currency || "币种未知"}）`, description: "例如已核实的过期、退款回收等，不能把 API 用量填在这里。",
				value: nonUsage, inputMode: "decimal", maxLength: 30, disabled: busy,
				onChange: (event) => edit(setNonUsage, event.currentTarget.value),
				error: nonUsage && !validLedgerDecimal(nonUsage) ? "需为非负金额、最多 8 位小数且不超过 90071992.54740991" : undefined,
			}),
		),
		h(M.Textarea, { label: "核对说明", value: note, maxLength: 300, minRows: 2, disabled: busy,
			description: `${note.length}/300 字，必填；纯文本，不执行 HTML。请勿填写密钥。`,
			error: noteError || undefined,
			onChange: (event) => editNote(event.currentTarget.value), placeholder: "记录核对依据，例如哪个服务商账单或入账凭证。" }),
		h(M.Checkbox, {
			label: `我已核对上述账户、${account.currency || "币种"}和 revision ${revision}，确认这些是整个观测区间的累计值。`,
			checked: confirmed, disabled: busy, onChange: (event) => setConfirmed(event.currentTarget.checked),
		}),
		h(M.Button, {
			size: "xs", disabled: busy || !confirmed || !valid || !account.currency,
			onClick: () => {
				if (!requireNote()) return;
				setConfirmed(false);
				onCorrect({ action: "set", accountId: account.accountId, revision, confirmed: true,
					confirmedTopUp: topUp.trim(), nonUsageDebit: nonUsage.trim(), note: note.trim() });
			},
		}, "确认并记录校正"),
		h("div", { className: "pet-settings-audit" },
			h(M.Text, { size: "sm", fw: 600 }, "校正记录"),
			audit.length === 0 ? h(M.Text, { size: "xs", c: "dimmed" }, "尚无人工校正记录。") : null,
			...[...audit].reverse().map((entry) => h("article", { key: entry.id, className: "pet-settings-record" },
				h(M.Group, { justify: "space-between", gap: "xs" },
					h(M.Text, { size: "xs", fw: 600 }, `${entry.action === "undo" ? "撤销" : "校正"} · ${ledgerTime(entry.at, account.timeZone)}`),
					h(M.Badge, { size: "xs", color: undone.has(entry.id) ? "gray" : "blue" }, undone.has(entry.id) ? "已撤销" : entry.action === "undo" ? "撤销记录" : "已记录"),
				),
				h(M.Text, { size: "xs", c: "dimmed" }, `记录 ID：${entry.id}`),
				entry.before ? h(M.Text, { size: "xs" }, `之前：累计到账 ${ledgerAmount(entry.before.confirmedTopUp, account.currency)}；非调用扣减 ${ledgerAmount(entry.before.nonUsageDebit, account.currency)}`) : null,
				entry.after ? h(M.Text, { size: "xs" }, `之后：累计到账 ${ledgerAmount(entry.after.confirmedTopUp, account.currency)}；非调用扣减 ${ledgerAmount(entry.after.nonUsageDebit, account.currency)}`) : null,
				entry.note ? h(M.Text, { size: "xs", className: "pet-settings-plain-text" }, entry.note) : null,
				entry.undoOf ? h(M.Text, { size: "xs", c: "dimmed" }, `撤销目标：${entry.undoOf}`) : null,
				latest?.id === entry.id ? h(M.Button, { size: "compact-xs", variant: "subtle", color: "red", disabled: busy,
					onClick: () => { setUndoTarget(entry); setConfirmed(false); } }, "撤销这次校正…") : null,
			)),
		),
		h(M.Modal, { opened: Boolean(undoTarget), onClose: () => setUndoTarget(null), title: "确认撤销最近一次校正", centered: true },
			h(M.Stack, { gap: "sm" },
				h(M.Text, { size: "sm" }, `仅撤销 ${account.label || account.accountId}（${account.currency}）的记录 ${undoTarget?.id ?? ""}，使用 revision ${revision}。撤销将恢复该记录之前的校正值，并保留审计记录。`),
				h(M.Textarea, { label: "撤销说明", value: note, maxLength: 300, minRows: 2, error: noteError || undefined,
					description: `${note.length}/300 字，必填；纯文本，不执行 HTML。`,
					onChange: (event) => editNote(event.currentTarget.value) }),
				h(M.Group, { justify: "flex-end" },
					h(M.Button, { size: "xs", variant: "default", onClick: () => setUndoTarget(null) }, "取消"),
					h(M.Button, { size: "xs", color: "red", disabled: busy || !undoTarget,
						onClick: () => {
							if (!undoTarget || !requireNote()) return;
							const correctionId = undoTarget.id;
							setUndoTarget(null);
							onCorrect({ action: "undo", accountId: account.accountId, revision, confirmed: true, correctionId, note: note.trim() });
						} }, "确认撤销并记录"),
				),
			),
		),
	);
}

function AlertSettings({ value, accounts, loaded, onChange }) {
	const rules = Array.isArray(value?.rules) ? value.rules : [];
	const [draft, setDraft] = React.useState(null);
	const [formError, setFormError] = React.useState("");
	const selected = accounts.find((account) => account.accountId === draft?.accountId && account.currency === draft?.currency);
	const percent = draft?.kind === "balance" && draft?.metric === "remainingPercent";
	const accountOptions = accounts.filter((account) => account.currency).map((account) => ({
		value: account.accountId, label: `${account.label || account.accountId} · ${account.currency || "币种未知"}`,
	}));
	const startRule = (rule) => {
		setFormError("");
		setDraft(rule ? { metric: "amount", ...rule } : {
			id: `rule-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`}`,
			enabled: true, accountId: "", currency: "", kind: "balance", metric: "amount",
			threshold: "", hysteresis: "0", version: 1,
		});
	};
	const editDraft = (patch) => { setDraft((current) => ({ ...current, ...patch })); setFormError(""); };
	const saveRule = () => {
		if (!selected) return setFormError("请选择当前账本中的一个账户，账户 ID 与币种必须精确匹配。");
		if (!validLedgerDecimal(String(draft.threshold)) || !validLedgerDecimal(String(draft.hysteresis))) {
			return setFormError("阈值和恢复迟滞必须为非负数字、最多 8 位小数，且不超过 90071992.54740991。");
		}
		if (percent && (Number(draft.threshold) > 100 || Number(draft.hysteresis) > 100)) {
			return setFormError("剩余比例与恢复迟滞的单位为百分比，必须在 0–100 内。");
		}
		const previous = rules.find((rule) => rule.id === draft.id);
		if (!previous && rules.length >= 32) return setFormError("最多保留 32 条规则，请先删除不用的规则。");
		const next = { ...draft, threshold: String(draft.threshold).trim(), hysteresis: String(draft.hysteresis).trim(),
			metric: draft.kind === "budget" ? "amount" : draft.metric,
			version: previous ? (Number(previous.version) || 1) + 1 : 1 };
		onChange({ rules: previous ? rules.map((rule) => rule.id === next.id ? next : rule) : [...rules, next] });
		setDraft(null);
	};
	return h(Section, {
		title: "余额预警与今日观测预算",
		description: "默认关闭；每条规则只匹配一个账户 ID 和币种。预算依据当日实际观测到的余额下降，不等于宿主逐轮计费。",
	},
		h(Toggle, { label: "启用预警", checked: value?.enabled === true,
			description: "规则保留在本插件中。关闭后不生成新的预警；不会替代服务商账单。", onChange: (enabled) => onChange({ enabled }) }),
		h(M.Text, { size: "xs", c: "dimmed" }, "绝对余额以账户币种计量；真实剩余比例以 % 计量。只有余额 API 同时给出剩余与已用额度时才有剩余比例，不能用参考金额或累计充值凑百分比。POINTS 等未知单位不适用金额预算。"),
		rules.length === 0 ? h(M.Text, { size: "xs", c: "dimmed" }, "尚未配置预警规则。") : null,
		...rules.map((rule) => {
			const account = accounts.find((entry) => entry.accountId === rule.accountId && entry.currency === rule.currency);
			const usesPercent = rule.kind === "balance" && rule.metric === "remainingPercent";
			const unavailable = !loaded ? "账本尚未读取，规则状态待确认" : !account ? "账户/币种未匹配，暂不触发" : account.stale ? "观测已过期，等待新样本" :
				usesPercent && account.remainingPercent == null ? "缺少真实总额度，不触发比例预警" :
				rule.kind === "budget" && !account.eligible ? "积分/未知单位或没有真实金额观测，不触发预算预警" : "仅在有效观测满足规则时触发";
			return h("article", { key: rule.id, className: "pet-settings-record" },
				h(M.Group, { justify: "space-between", gap: "xs" },
					h(M.Text, { size: "sm", fw: 600 }, `${rule.kind === "budget" ? "今日观测预算达到" : "剩余余额低于"} ${ledgerAmount(rule.threshold, usesPercent ? "%" : rule.currency)}`),
					h(M.Switch, { size: "xs", "aria-label": `启用规则 ${rule.id}`, checked: rule.enabled !== false,
						onChange: (event) => onChange({ rules: rules.map((entry) => entry.id === rule.id ? { ...entry, enabled: event.currentTarget.checked } : entry) }) }),
				),
				h(M.Text, { size: "xs" }, `${account?.label || rule.accountId} · ${rule.currency} · 恢复迟滞 ${ledgerAmount(rule.hysteresis, usesPercent ? "百分点" : rule.currency)}`),
				h(M.Text, { size: "xs", c: "dimmed" }, value?.enabled !== true ? `总开关已关闭；${unavailable}` : unavailable),
				h(M.Group, { gap: "xs" },
					h(M.Button, { size: "compact-xs", variant: "subtle", onClick: () => startRule(rule) }, "编辑规则"),
					h(M.Button, { size: "compact-xs", variant: "subtle", color: "red", onClick: () => {
						onChange({ rules: rules.filter((entry) => entry.id !== rule.id) });
						if (draft?.id === rule.id) setDraft(null);
					} }, "删除规则"),
				),
			);
		}),
		h(M.Button, { size: "xs", variant: "light", disabled: rules.length >= 32 || accountOptions.length === 0,
			onClick: () => startRule(null) }, `添加规则（${rules.length}/32）`),
		accountOptions.length === 0 ? h(M.Text, { size: "xs", c: "dimmed" }, "先在「余额 API」页查询余额，再刷新此页账本；没有账户与币种时不能创建规则。") : null,
		draft ? h("div", { className: "pet-settings-form" },
			h(M.Stack, { gap: "sm" },
				h(M.Text, { size: "sm", fw: 600 }, "规则编辑（点击保存规则后生效）"),
				h(M.Select, { label: "精确匹配的账户与币种", value: draft.accountId || null, data: accountOptions,
					onChange: (accountId) => {
						const account = accounts.find((entry) => entry.accountId === accountId);
						editDraft({ accountId: account?.accountId ?? "", currency: account?.currency ?? "", threshold: "", hysteresis: "0" });
					} }),
				h(M.Select, { label: "规则类型", value: draft.kind, data: [
					{ value: "balance", label: "余额低于阈值" }, { value: "budget", label: "今日观测下降达到预算" },
				], onChange: (kind) => editDraft({ kind: kind || "balance", metric: "amount", threshold: "", hysteresis: "0" }) }),
				draft.kind === "balance" ? h(M.Select, { label: "阈值单位", value: draft.metric, data: [
					{ value: "amount", label: `绝对余额（${draft.currency || "请先选账户"}）` },
					{ value: "remainingPercent", label: "真实剩余比例（%）" },
				], onChange: (metric) => editDraft({ metric: metric || "amount", threshold: "", hysteresis: "0" }) }) : null,
				percent && selected?.remainingPercent == null ? h(M.Alert, { color: "yellow", p: "xs" }, "该账户目前没有真实剩余比例。可以保存规则，但在得到真实总额度前不会触发。") : null,
				h("div", { className: "pet-settings-columns" },
					h(M.TextInput, { label: `阈值（${percent ? "%" : draft.currency || "币种未知"}）`, value: String(draft.threshold),
						inputMode: "decimal", maxLength: 30, onChange: (event) => editDraft({ threshold: event.currentTarget.value }) }),
					h(M.TextInput, { label: `恢复迟滞（${percent ? "百分点" : draft.currency || "币种未知"}）`, value: String(draft.hysteresis),
						inputMode: "decimal", maxLength: 30, onChange: (event) => editDraft({ hysteresis: event.currentTarget.value }) }),
				),
				h(M.Text, { size: "xs", c: "dimmed" }, "切换账户、规则类型或单位会清空阈值，避免把金额当成百分比。余额恢复超过阈值加迟滞后才重新武装，避免反复提醒。"),
				formError ? h(M.Alert, { color: "red", p: "xs" }, formError) : null,
				h(M.Group, { justify: "flex-end" },
					h(M.Button, { size: "xs", variant: "default", onClick: () => setDraft(null) }, "取消"),
					h(M.Button, { size: "xs", onClick: saveRule }, "保存规则"),
				),
			),
		) : null,
	);
}

function LedgerSettings({ accounting, alerts, onAccountingChange, onAlertsChange, configPending }) {
	const [ledger, setLedger] = React.useState(null);
	const [selectedId, setSelectedId] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState("");
	const [message, setMessage] = React.useState("");
	const mounted = React.useRef(false);
	const loadLedger = React.useCallback(async (preserveError = false) => {
		setBusy(true);
		if (!preserveError) { setError(""); setMessage(""); }
		const result = await SDK.callSafe("pet-ledger-get", { days: 31, audit: true });
		if (!mounted.current) return;
		setBusy(false);
		if (!result.ok) { setError(result.error.message); return; }
		if (!result.value?.ledger) { setError("服务端未返回账本，不能推断账户余额或消费。"); return; }
		setLedger(result.value.ledger);
	}, []);
	React.useEffect(() => {
		mounted.current = true;
		loadLedger();
		return () => { mounted.current = false; };
	}, [loadLedger]);
	const accounts = Array.isArray(ledger?.accounts) ? ledger.accounts : [];
	const account = accounts.find((entry) => entry.accountId === selectedId) ?? accounts[0];
	const correct = async (input) => {
		setBusy(true); setError(""); setMessage("");
		const result = await SDK.callSafe("pet-ledger-correct", input);
		if (!mounted.current) return;
		setBusy(false);
		if (!result.ok) {
			const conflict = result.error?.data?.cause === "REVISION_CONFLICT" || /REVISION_CONFLICT|版本冲突|版本已|账本已变化/.test(result.error.message ?? "");
			setError(conflict ? "账本版本已变化，正在尝试刷新。请重新核对读取到的 revision 和累计值；不会自动重试校正。" : result.error.message);
			await loadLedger(true);
			return;
		}
		if (result.value?.ledger) setLedger(result.value.ledger);
		else await loadLedger(true);
		setMessage(input.action === "undo" ? "撤销已记录；服务商余额未被修改。" : "校正已记录；未把整体修正净额分配为今日费用。");
	};
	const zone = account?.timeZone || accounting?.timeZone || localSettingsTimeZone();
	const reasons = Array.isArray(account?.incompleteReasons) ? account.incompleteReasons : [];
	const accountStatus = ledger?.status ?? "unavailable";
	const observedAmount = (amount) => account?.eligible === true ? ledgerAmount(amount, account.currency) : "不适用（积分/未知单位，或无真实货币观测）";
	return h(M.Stack, { gap: "sm" },
		h(Section, { title: "余额观测账本", description: "只记录实际取得的余额样本。余额下降是观测值，不是宿主提供的逐轮费用，也不代表完整账单。" },
			h(M.Group, { justify: "space-between" },
				h(M.Badge, { color: accountStatus === "ready" ? "blue" : "yellow", variant: "light" },
					ledger ? `revision ${ledger.revision ?? "未知"} · ${accountStatus === "ready" ? "可读取" : accountStatus === "corrupt" ? "数据异常" : "暂不可用"}` : "尚未读取"),
				h(M.Button, { size: "xs", variant: "light", onClick: () => loadLedger(), loading: busy, disabled: configPending }, "刷新账本"),
			),
			configPending ? h(M.Text, { size: "xs", c: "dimmed" }, "配置尚在保存，保存完成后刷新账本以应用新设置。") : null,
			error ? h(M.Alert, { color: "red", title: "未完成操作", p: "sm" }, error) : null,
			message ? h(M.Alert, { color: "green", p: "sm" }, message) : null,
			ledger?.error ? h(M.Alert, { color: "yellow", title: "账本不可用", p: "sm" }, typeof ledger.error === "string" ? ledger.error : ledger.error.message || "数据无法读取，请保留现有数据后重试。") : null,
			accounts.length === 0 ? h(M.Text, { size: "sm", c: "dimmed" }, busy ? "正在读取真实观测…" : "还没有可用账户。到「余额 API」查询一次，再刷新账本；此处不会填入示例余额。") : null,
			accounts.length > 0 ? h(M.Select, { label: "账户（分别展示，不合并不同币种）", value: account?.accountId ?? null,
				data: accounts.map((entry) => ({ value: entry.accountId, label: `${entry.label || entry.accountId} · ${entry.currency || "币种未知"}` })),
				onChange: (value) => { setSelectedId(value || ""); setMessage(""); }, disabled: busy }) : null,
			account ? h(FactGrid, { rows: [
				["账户 ID", account.accountId],
				["币种 / 额度形态", `${account.currency || "未知"} / ${account.shape || "未知"}`],
				["统计时区", zone], ["首次观测", ledgerTime(account.observedFrom, zone)], ["最近观测", ledgerTime(account.observedTo || account.sampledAt, zone)],
				["当前余额", ledgerAmount(account.balance, account.currency)],
				["真实剩余比例", account.remainingPercent == null ? "未知（不以参考金额估算）" : `${Number(account.remainingPercent).toFixed(2)}%`],
				["期初余额", ledgerAmount(account.openingBalance, account.currency)],
				["观测下降累计", observedAmount(account.observedSpend)],
				["观测上涨累计（待核对）", observedAmount(account.observedRise)],
				["已确认累计到账", !account.eligible ? "不适用" : account.confirmedTopUp == null ? "尚未人工确认" : ledgerAmount(account.confirmedTopUp, account.currency)],
				["非调用扣减", observedAmount(account.nonUsageDebit)],
				["整体修正净额", !account.eligible ? "不适用（非真实货币观测）" : account.correctedSpend == null ? "未知（未确认累计到账）" : ledgerAmount(account.correctedSpend, account.currency)],
				["未分配到具体日期的下降", observedAmount(account.unallocatedSpend)],
				["未分配到具体日期的上涨", observedAmount(account.unallocatedRise)],
			] }) : null,
			account?.stale ? h(M.Alert, { color: "yellow", p: "xs" }, "最近样本已过期。请先刷新余额；不应把旧余额当作实时金额。") : null,
			account?.correctedSpend && String(account.correctedSpend).startsWith("-") ? h(M.Alert, { color: "yellow", p: "xs" }, "整体修正净额为负，说明累计到账或其他校正仍有待核对；这不表示 API 产生负费用。") : null,
		),
		account ? h(Section, { title: "今日观测与完整性", description: "以下仅覆盖实际观测区间。离线、跨日或较长采样间隔不会被伪装为今日的完整消费。" },
			h(FactGrid, { rows: [
				["日期", `${account.today?.date || "未知"}（${zone}）`],
				["今日观测下降", observedAmount(account.today?.spend)],
				["今日观测上涨（待核对）", observedAmount(account.today?.rise)],
			] }),
			h(M.Alert, { color: reasons.length > 0 ? "yellow" : "blue", title: "不完整原因 / 数据边界", p: "sm" },
				h(M.Stack, { gap: 3 },
					...(reasons.length > 0 ? reasons : ["未报告额外缺口；仍仅是余额观测，不是逐轮费用或服务商完整账单。"]).map((reason, index) => h(M.Text, { key: index, size: "xs" }, `· ${reason}`)),
					h(M.Text, { size: "xs" }, "余额上涨不能自动认定为充值；消费与入账若发生在同一采样间隔内，也可能互相抵消。"),
				),
			),
			account.eligible && Array.isArray(account.days) && account.days.length > 0 ? h("details", { className: "pet-settings-details" },
				h("summary", null, `最近 ${account.days.length} 天的观测记录`),
				h("div", { className: "pet-settings-table-scroll" }, h("table", { className: "pet-settings-table" },
					h("thead", null, h("tr", null, h("th", null, "日期"), h("th", null, `观测下降（${account.currency || "未知"}）`), h("th", null, `观测上涨（${account.currency || "未知"}）`))),
					h("tbody", null, ...account.days.map((day) => h("tr", { key: day.date }, h("td", null, day.date), h("td", null, ledgerAmount(day.spend)), h("td", null, ledgerAmount(day.rise))))),
				),
			),
			) : null,
		) : null,
		account && account.eligible === true && account.openingBalance != null && accountStatus === "ready" && ledger.revision != null ? h(LedgerCorrection, {
			key: `${account.accountId}:${ledger.revision}`, account, revision: ledger.revision, busy: busy || configPending, onCorrect: correct,
		}) : account ? h(M.Alert, { color: "blue", p: "sm" }, "当前账户缺少可核对的真实金额，或账本不可用；人工金额校正未开放。") : null,
		h(AlertSettings, { value: alerts, accounts, loaded: Boolean(ledger), onChange: onAlertsChange }),
		h(AccountingSettings, { value: accounting, onChange: onAccountingChange }),
	);
}

/* -------------------------------------------------------------------------- */
/* This settings view never subscribes or borrows another view's association.   */
/* -------------------------------------------------------------------------- */

function TaskSettings({ value, onChange }) {
	const [contextResult, setContextResult] = React.useState(null);
	const [bridgeAvailable, setBridgeAvailable] = React.useState(false);
	const [loading, setLoading] = React.useState(false);
	const mounted = React.useRef(false);
	const inspectContext = React.useCallback(async () => {
		setLoading(true);
		try { setBridgeAvailable(typeof SDK.events === "function" && Boolean(SDK.events())); }
		catch { setBridgeAvailable(false); }
		const result = typeof SDK.getContextSafe === "function"
			? await SDK.getContextSafe()
			: { ok: false, error: { message: "当前 SDK 未提供上下文读取能力。" } };
		if (!mounted.current) return;
		setContextResult(result);
		setLoading(false);
	}, []);
	React.useEffect(() => {
		mounted.current = true;
		inspectContext();
		return () => { mounted.current = false; };
	}, [inspectContext]);
	const narratorId = contextResult?.ok && typeof contextResult.value?.narrator?.id === "string"
		? contextResult.value.narrator.id : "";
	return h(M.Stack, { gap: "sm" },
		h(Section, { title: "任务提醒", description: "只处理当前视图上下文或你在舞台明确关联的 narrator，不查询全局列表，不自动发现其他会话。" },
			h(Toggle, { label: "启用任务提醒", checked: value?.enabled !== false,
				description: "开关只表示允许舞台尝试订阅；不代表宿主已授权或已有真实事件到达。", onChange: (enabled) => onChange({ enabled }) }),
			h(M.Alert, { color: "blue", title: "请在桌宠舞台管理关联", p: "sm" },
				h(M.Text, { size: "xs" }, "设置页和桌宠舞台是不同视图。为避免把本设置页的上下文错误地套到舞台，这里不新增或修改 narrator 关联。"),
				h(M.Text, { size: "xs" }, "舞台应显示关联的 narrator ID / 别名；手动关联仅保存在该舞台视图的内存或 sessionStorage，绝不写入全局插件配置。"),
			),
		),
		h(Section, { title: "当前设置视图上下文（只读）", description: "这是设置页自己的上下文预览，不是桌宠舞台的关联列表。不会读取、复制或猜测其他视图的绑定。" },
			h(M.Group, { justify: "space-between", gap: "xs" },
				h(M.Badge, { variant: "light", color: narratorId ? "blue" : "gray" }, narratorId ? "宿主提供本视图上下文" : "本视图未关联 narrator"),
				h(M.Button, { size: "xs", variant: "light", loading, onClick: inspectContext }, "重新检查本视图"),
			),
			h(FactGrid, { rows: [
				["narrator ID", narratorId || "未提供"],
				["别名", "宿主未提供别名；以桌宠舞台内明确设置的关联别名为准"],
				["关联来源", narratorId ? "宿主 context.narrator.id（仅本视图）" : "无；不会退回全局会话列表"],
				["上下文读取能力", loading ? "检查中" : contextResult?.ok ? "可读取" : "不可用"],
				["事件桥方法", bridgeAvailable ? "可用（未订阅，不能等同于已授权）" : "不可用 / 宿主未提供"],
				["event.subscribe 授权", "设置页不创建订阅，授权状态未在此验证"],
			] }),
			contextResult && !contextResult.ok ? h(M.Alert, { color: "yellow", p: "xs" }, contextResult.error?.message || "无法读取当前上下文。") : null,
		),
		h(Section, { title: "授权与能力边界" },
			h(M.Alert, { color: "yellow", title: "升级新增权限需要重新授权", p: "sm" },
				h(M.Text, { size: "xs" }, "本版使用 event.subscribe。升级后若宿主仍保留旧权限，请在插件权限中重新确认授权，再回到桌宠舞台检查订阅状态。仅能检测到桥方法，不代表订阅权限已获批准。"),
			),
			h(FactGrid, { rows: [
				["逐轮费用", "宿主未提供逐轮费用；账本只有余额观测，不能作为单轮计费。"],
				["等待回答", "缺少可靠提问信号，无法确认正在等待你回答。"],
				["真实任务状态", "只以舞台实际授权且收到的、范围匹配的事件为依据。"],
				["示例模板", "所有模板预览均为模拟，不能当成真实已接线或已发生的事件。"],
			] }),
			h(M.Text, { size: "xs", c: "dimmed" }, "本页只读取自身 context 并检测 SDK 方法，不调用 events.subscribe / poll / unsubscribe，也不领取或确认系统提醒。"),
		),
	);
}

// Merge pending sections instead of losing a fast second edit in another tab.
function mergeSettings(base, patch) {
	const merged = { ...base };
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (["__proto__", "prototype", "constructor"].includes(key)) continue;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			merged[key] = mergeSettings(base?.[key] ?? {}, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/* -------------------------------------------------------------------------- */
/* Balance API: one HTTPS endpoint, one key, no host cache, no narrator map.    */
/* -------------------------------------------------------------------------- */

/** The only secret this plugin reads or writes. */
const BALANCE_SECRET_KEY = "customApiKey";

// The unit is chosen by the user and never inferred from the response: POINTS is a
// raw count and must not be read as a currency budget.
const BALANCE_CURRENCIES = ["POINTS", "CNY", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "HKD", "SGD", "KRW", "INR", "TWD", "NZD", "RUB", "BRL"];
const BALANCE_CURRENCY_DATA = BALANCE_CURRENCIES.map((code) => ({
	value: code,
	label: code === "POINTS" ? "POINTS（积分 / 未知单位）" : code,
}));

/**
 * The endpoint is the only network target this plugin calls, so the panel refuses
 * anything that is not a plain HTTPS URL: no credentials in the URL, no
 * whitespace/control characters, and never a key smuggled into the query string.
 */
function balanceUrlError(value) {
	const text = String(value ?? "").trim();
	if (!text) return "";
	if (text.length > 500) return "URL 过长（最多 500 个字符）。";
	if (/[\s\u0000-\u001f\u007f]/.test(text)) return "URL 不能包含空白、换行或控制字符。";
	if (!/^https:\/\//i.test(text)) return "只支持 https:// 开头的地址。";
	let url;
	try { url = new URL(text); }
	catch { return "URL 格式不正确。"; }
	if (url.protocol !== "https:") return "只支持 HTTPS。";
	if (url.username || url.password) return "URL 不能包含用户名或密码；API Key 请填在下方输入框。";
	if (!url.hostname) return "URL 缺少主机名。";
	if (/(?:^|[?&])(?:api[_-]?key|key|token|secret|access[_-]?token|authorization)=/i.test(url.search)) {
		return "URL 里不能带密钥参数；API Key 只通过 Authorization: Bearer 发送。";
	}
	return "";
}

/**
 * Response fields are dot-separated JSON keys, never an expression: the backend
 * only walks literal keys, so the panel rejects anything else before it is saved.
 */
function balancePathError(value, required) {
	const text = String(value ?? "").trim();
	if (!text) return required ? "必填：这个路径必须指向响应里的剩余额度。" : "";
	if (text.length > 160) return "路径过长（最多 160 个字符）。";
	if (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(text)) return "只允许用点分隔的字段名（字母、数字、_、-），例如 data.balance。";
	return "";
}

/**
 * Backend failures arrive as `{ kind, message }`. Keep them short and never echo a
 * provider payload back into the panel; the backend already redacts the key.
 */
function balanceFailureText(error) {
	const kind = String(error?.kind ?? error?.code ?? "").toLowerCase();
	const message = typeof error?.message === "string" ? error.message.trim().slice(0, 160) : "";
	if (/shape|field|path|non_?numeric|amount|mismatch/.test(kind)) return "响应字段不匹配：剩余额度字段路径没有指向有效数字（不会当成 0）。";
	if (/missing_?secret|no_?secret|unconfigured|not_?configured|missing_?url/.test(kind)) return "尚未配置余额 API 或 API Key：先保存 URL 与 Key 再查询。";
	if (/auth|unauthor|forbidden|credential|401|403/.test(kind)) return "鉴权失败（401/403）：API Key 无效或没有权限。";
	if (/redirect/.test(kind)) return "余额 API 返回了重定向；插件只接受直连的 HTTPS 响应。";
	if (/timeout|deadline/.test(kind)) return "余额 API 请求超时。";
	if (/network|fetch|connect|dns|tls|cert|socket/.test(kind)) return "网络请求失败：无法连接余额 API。";
	if (/url|https|protocol|insecure/.test(kind)) return "余额 API 地址无效：需要一个 HTTPS 直连地址。";
	if (/json|parse/.test(kind)) return "余额 API 没有返回合法 JSON。";
	return message ? `余额查询失败：${message}` : "余额查询失败。";
}

function BalanceApiSettings({ balance, secret, keyDraft, keyNotice, busy, result, configPending,
	onPatch, onPatchCustom, onKeyDraft, onSaveKey, onDeleteKey, onQuery }) {
	const custom = balance?.custom ?? {};
	const savedUrl = typeof custom.url === "string" ? custom.url : "";
	const savedTotalPath = typeof custom.totalPath === "string" ? custom.totalPath : "";
	const savedUsedPath = typeof custom.usedPath === "string" ? custom.usedPath : "";
	const [draft, setDraft] = React.useState({ url: savedUrl, totalPath: savedTotalPath, usedPath: savedUsedPath });
	const [touched, setTouched] = React.useState({ url: false, totalPath: false, usedPath: false });
	// Re-sync only when the *saved* value changed: a save round-trip must not
	// overwrite text that is still being typed.
	React.useEffect(() => {
		setDraft((current) => ({ ...current, url: savedUrl, totalPath: savedTotalPath, usedPath: savedUsedPath }));
	}, [savedUrl, savedTotalPath, savedUsedPath]);

	const urlError = balanceUrlError(draft.url);
	const totalPathError = balancePathError(draft.totalPath, true);
	const usedPathError = balancePathError(draft.usedPath, false);
	// An untouched empty form is "not configured yet", not an error.
	const shownUrlError = touched.url || savedUrl ? urlError : "";
	const shownTotalPathError = touched.totalPath || savedTotalPath ? totalPathError : "";
	const invalid = Boolean(shownUrlError || shownTotalPathError || usedPathError);
	const currency = BALANCE_CURRENCIES.includes(custom.currency) ? custom.currency : "POINTS";
	const refreshMinutes = Number.isFinite(balance?.refreshMinutes) ? balance.refreshMinutes : 30;
	const configured = secret?.configured === true;
	const edit = (field, raw) => {
		setDraft((current) => ({ ...current, [field]: raw }));
		setTouched((current) => ({ ...current, [field]: true }));
		const invalidValue = field === "url" ? balanceUrlError(raw) : balancePathError(raw, field === "totalPath");
		// Only a value the backend can use is written through, so a half-typed URL
		// never becomes saved config.
		if (!invalidValue) onPatchCustom({ [field]: raw.trim() });
	};

	return h(Section, {
		title: "余额 API",
		description: "唯一的余额数据源：本插件直接请求你自己配置的第三方 HTTPS 接口；不读取 NarraFork 宿主缓存、日志或任何叙述者上下文。",
	},
		h(M.Alert, { color: "blue", p: "sm", title: "固定的请求方式" },
			h(M.Text, { size: "xs" }, "固定 HTTPS GET；API Key 只放在 Authorization: Bearer 请求头里。没有请求方法、额外请求头或把密钥拼进 URL 的入口。"),
			h(M.Text, { size: "xs" }, "响应结构因服务而异：「响应字段」里的剩余额度路径必须指向一个数字；路径缺失或不是数字会显示 shape mismatch，不会当成 0。"),
		),
		h(M.Stack, { gap: "sm" },
			h(M.TextInput, {
				label: "API URL",
				placeholder: "https://example.com/api/balance",
				description: "必须是 HTTPS 直连地址；不要写用户名/密码，也不要把密钥放进查询参数。",
				value: draft.url,
				error: shownUrlError || undefined,
				maxLength: 500,
				autoComplete: "off",
				spellCheck: false,
				onChange: (event) => edit("url", event.currentTarget.value),
			}),
			h("div", { className: "pet-settings-key-row" },
				h(M.PasswordInput, {
					label: "API Key",
					description: configured ? "已保存在宿主 secret vault（customApiKey）；输入新值可覆盖。" : "尚未配置。只写不读，任何界面都不会回显明文。",
					placeholder: configured ? "已配置（输入新值可覆盖）" : "粘贴该余额 API 的 API Key",
					value: keyDraft ?? "",
					maxLength: 512,
					autoComplete: "off",
					spellCheck: false,
					style: { flex: "1 1 auto" },
					onChange: (event) => onKeyDraft(event.currentTarget.value),
				}),
				h(M.Button, { size: "xs", onClick: onSaveKey, disabled: !String(keyDraft ?? "").trim() }, configured ? "更换 Key" : "保存 Key"),
				configured ? h(M.Button, { size: "xs", variant: "subtle", color: "red", onClick: onDeleteKey }, "删除 Key") : null,
			),
			h(M.Group, { gap: "xs", align: "flex-start", wrap: "wrap" },
				h(M.Badge, { color: configured ? "green" : "gray", variant: "light" },
					configured ? "customApiKey 已配置" : "customApiKey 未配置"),
				h(M.Text, { size: "xs", c: "dimmed" },
					"旧版内置服务商的密钥不会自动转移到这里：需要时请把目标服务的 Key 重新录入上方 API Key（旧密钥仍留在宿主中，插件不回显、不删除，也不会再使用）。"),
			),
			keyNotice ? h(M.Alert, { color: keyNotice.tone === "ok" ? "green" : "red", p: "xs" }, keyNotice.text) : null,
			h(SliderRow, {
				label: "查询周期",
				value: refreshMinutes,
				min: 1,
				max: 240,
				step: 1,
				onChange: (value) => onPatch({ refreshMinutes: value }),
				format: (value) => `${value} 分钟`,
			}),
			h(M.Group, { gap: "xs", align: "center", wrap: "wrap" },
				h(M.Button, {
					size: "xs",
					onClick: onQuery,
					loading: busy,
					disabled: busy || configPending || invalid,
				}, "立即查询"),
				configPending
					? h(M.Text, { size: "xs", c: "dimmed" }, "有改动正在保存；保存完成后才能立即查询。")
					: invalid
						? h(M.Text, { size: "xs", c: "yellow" }, "请先修正上方标红的地址或字段路径；无效内容不会被保存。")
						: h(M.Text, { size: "xs", c: "dimmed" }, "查询使用已保存的 URL、字段路径、单位与 customApiKey。"),
			),
			result ? h(M.Alert, { color: result.tone === "ok" ? "green" : result.tone === "warn" ? "yellow" : "red", p: "sm" }, result.text) : null,
			h("details", { className: "pet-settings-details" },
				h("summary", null, "响应字段与单位（高级）"),
				h(M.Stack, { gap: "sm" },
					h(M.TextInput, {
						label: "剩余额度字段路径（totalPath，必填）",
						description: "点号分隔的 JSON 字段，必须指向剩余金额，例如 data.balance 或 balance.remaining。",
						placeholder: "data.balance",
						value: draft.totalPath,
						error: shownTotalPathError || undefined,
						maxLength: 160,
						autoComplete: "off",
						spellCheck: false,
						onChange: (event) => edit("totalPath", event.currentTarget.value),
					}),
					h(M.TextInput, {
						label: "已用额度字段路径（usedPath，可选）",
						description: "填了才会显示额度比例（已用 ÷(已用+剩余)）；留空只显示剩余值，不伪造已用百分比。",
						placeholder: "data.used",
						value: draft.usedPath,
						error: usedPathError || undefined,
						maxLength: 160,
						autoComplete: "off",
						spellCheck: false,
						onChange: (event) => edit("usedPath", event.currentTarget.value),
					}),
					h(M.Select, {
						label: "余额单位（currency）",
						description: "接口通常不返回单位，所以由你明确指定；不做自动猜测。",
						data: BALANCE_CURRENCY_DATA,
						value: currency,
						allowDeselect: false,
						onChange: (value) => onPatchCustom({ currency: value ?? "POINTS" }),
					}),
					h(M.Text, { size: "xs", c: "dimmed" },
						currency === "POINTS"
							? "当前为 POINTS（积分 / 未知单位）：数值照实显示，但不计算货币消费、不启用金额预算与金额预警。"
							: `当前单位 ${currency}：账本按该币种记录观测金额，才启用货币消费与金额预算；不同单位/URL/字段路径的账户基线互不相通。`),
				),
			),
		),
	);
}

function App() {
	const [config, setConfig] = React.useState(undefined);
	const [warnings, setWarnings] = React.useState([]);
	const [status, setStatus] = React.useState("loading");
	// Only `customApiKey` is ever loaded, shown or managed here.
	const [secrets, setSecrets] = React.useState([]);
	const [balanceBusy, setBalanceBusy] = React.useState(false);
	const [balanceResult, setBalanceResult] = React.useState(undefined);
	const [keyNotice, setKeyNotice] = React.useState(undefined);
	const [draftSecret, setDraftSecret] = React.useState({});
	const [tab, setTab] = React.useState("pet");
	const [resetConfirm, setResetConfirm] = React.useState(false);
	const saveTimer = React.useRef(0);
	const pendingSave = React.useRef(undefined);
	const saveInFlight = React.useRef(false);
	const flushSaveRef = React.useRef(() => {});
	// `commit` needs the newest config synchronously. Reading it from a ref rather
	// than from the state updater keeps the debounce scheduling out of render-phase
	// code, where a double-invoked updater would arm the timer twice.
	const configRef = React.useRef(undefined);
	configRef.current = config;

	const loadSecrets = React.useCallback(async () => {
		const result = await SDK.callSafe("pet-secrets-list");
		if (!result.ok) return;
		const keys = Array.isArray(result.value?.keys) ? result.value.keys : [];
		// Old built-in provider keys are deliberately invisible and untouched.
		setSecrets(keys.filter((entry) => entry && entry.key === BALANCE_SECRET_KEY));
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
			configRef.current = configResult.value.config;
			setConfig(configResult.value.config);
			setWarnings(configResult.value.warnings ?? []);
			await loadSecrets();
			if (!cancelled) setStatus((current) => current === "loading" ? "ready" : current);
		})();
		return () => {
			cancelled = true;
		};
	}, [loadSecrets]);

	// Serialize writes and retain edits made while a previous response is in flight.
	// A rejected save keeps its patch for an explicit retry instead of hiding the UI.
	const flushSave = React.useCallback(async () => {
		if (saveInFlight.current) {
			// A write is already on the wire; do not drop the newer patch on the floor.
			if (pendingSave.current) {
				clearTimeout(saveTimer.current);
				saveTimer.current = setTimeout(() => flushSaveRef.current(), 120);
			}
			return;
		}
		if (!pendingSave.current) return;
		const toSave = pendingSave.current;
		pendingSave.current = undefined;
		saveInFlight.current = true;
		setStatus("saving");
		const result = await SDK.callSafe("pet-config-set", { patch: toSave });
		saveInFlight.current = false;
		if (!result.ok) {
			clearTimeout(saveTimer.current);
			pendingSave.current = mergeSettings(toSave, pendingSave.current);
			setStatus(`save-error: ${result.error.message}`);
			return;
		}
		const next = mergeSettings(result.value.config, pendingSave.current);
		configRef.current = next;
		setConfig(next);
		setWarnings(result.value.warnings ?? []);
		setStatus(pendingSave.current ? "pending" : "saved");
		if (pendingSave.current) {
			clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => flushSaveRef.current(), 0);
		}
	}, []);
	flushSaveRef.current = flushSave;

	const commit = React.useCallback((patch) => {
		const previous = configRef.current;
		if (!previous) return;
		const value = typeof patch === "function" ? patch(previous) : patch;
		const next = mergeSettings(previous, value);
		configRef.current = next;
		setConfig(next);
		pendingSave.current = mergeSettings(pendingSave.current ?? {}, value);
		setStatus("pending");
		clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => flushSaveRef.current(), 420);
	}, []);

	React.useEffect(() => () => clearTimeout(saveTimer.current), []);

	const replaceConfiguration = async (reset = false) => {
		if (saveInFlight.current || pendingSave.current) return;
		saveInFlight.current = true;
		setStatus("saving");
		const result = await SDK.callSafe(reset ? "pet-config-set" : "pet-config-get", reset ? { reset: true } : {});
		saveInFlight.current = false;
		if (!result.ok) {
			clearTimeout(saveTimer.current);
			setStatus(`save-error: ${result.error.message}`);
			return;
		}
		// Edits made while this read/reset was in flight still belong to the user.
		const next = mergeSettings(result.value.config, pendingSave.current);
		configRef.current = next;
		setConfig(next);
		setWarnings(result.value.warnings ?? []);
		setStatus(pendingSave.current ? "pending" : reset ? "saved" : "ready");
		if (pendingSave.current) {
			clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => flushSaveRef.current(), 0);
		}
	};
	const reloadConfig = () => replaceConfiguration(false);
	const resetConfig = () => { setResetConfirm(false); return replaceConfiguration(true); };

	const saveSecret = async (secretKey) => {
		if (secretKey !== BALANCE_SECRET_KEY) return;
		const value = (draftSecret[secretKey] ?? "").trim();
		if (!value) return;
		try {
			await SDK.bridge().secrets.set(secretKey, value);
			setDraftSecret((previous) => ({ ...previous, [secretKey]: "" }));
			await loadSecrets();
			setKeyNotice({ tone: "ok", text: "API Key 已保存（不会回显）；下一次查询或刷新即使用新密钥。" });
		} catch (error) {
			setKeyNotice({ tone: "error", text: `保存失败：${error?.message ?? error}` });
		}
	};

	const clearSecret = async (secretKey) => {
		if (secretKey !== BALANCE_SECRET_KEY) return;
		try {
			await SDK.bridge().secrets.delete(secretKey);
			await loadSecrets();
			setKeyNotice({ tone: "ok", text: "API Key 已删除；在重新录入前余额查询会提示未配置。" });
		} catch (error) {
			setKeyNotice({ tone: "error", text: `删除失败：${error?.message ?? error}` });
		}
	};

	const testBalance = async () => {
		setBalanceBusy(true);
		setBalanceResult(undefined);
		// The single fixed endpoint: no provider, no source, no narrator.
		const result = await SDK.callSafe("pet-balance-refresh", { force: true });
		setBalanceBusy(false);
		if (!result.ok) {
			setBalanceResult({ tone: "error", text: balanceFailureText(result.error) });
			return;
		}
		const snapshot = result.value?.snapshot;
		const ledger = result.value?.ledger;
		if (!snapshot) {
			setBalanceResult({ tone: "warn", text: "请先保存余额 API 的 URL 与 API Key，再立即查询。" });
			return;
		}
		if (!snapshot.ok) {
			setBalanceResult({
				tone: snapshot.stale ? "warn" : "error",
				text: `${balanceFailureText(snapshot.error)}${snapshot.stale ? " 现在显示的仍是上一次成功查询的旧值。" : ""}`,
			});
			return;
		}
		const summary = typeof snapshot.summary === "string" && snapshot.summary.trim() ? snapshot.summary.trim() : "已取得余额";
		const accounts = Array.isArray(ledger?.accounts) ? ledger.accounts.length : 0;
		setBalanceResult({
			tone: "ok",
			text: `${summary}${snapshot.stale ? "（旧值，尚未取得新样本）" : ""} · 账本账户 ${accounts} 个；完整观测见「账本与预警」`,
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

	const patchBalance = (patch) => commit({ balance: patch });
	const patchBalanceCustom = (patch) => commit({ balance: { custom: patch } });
	const configPending = status === "pending" || status === "saving" || Boolean(pendingSave.current);
	const animationGroups = config.animationGroups ?? {};
	// Older stored configs predate `sound`; the backend fills the default in, but the
	// panel may render one frame before the first save round-trip.
	const sound = config.sound ?? { enabled: true, volume: 0.6 };
	const patchSound = (patch) => commit({ sound: { ...sound, ...patch } });

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
						status === "saving" ? "保存中，请勿关闭设置页…" : status === "pending" ? "有改动待保存，请勿关闭…" : status === "saved" ? "已保存" : status.startsWith("save-error:") ? "保存失败，改动尚未确认" : "改动会自动保存；文案与规则需点应用",
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
							onClick: reloadConfig,
							disabled: configPending,
						},
						"重新读取",
					),
					h(
						M.Button,
						{
							variant: "subtle",
							color: "red",
							size: "xs",
							onClick: () => setResetConfirm(true),
							disabled: configPending,
						},
						"恢复默认",
					),
				),
			),

			h(M.Modal, { opened: resetConfirm, onClose: () => setResetConfirm(false), title: "恢复全部设置默认值", centered: true },
				h(M.Stack, { gap: "sm" },
					h(M.Text, { size: "sm" }, "将恢复宠物、气泡、任务、余额 API、时区与预警设置，并清除自定义文案；不会清除已保存的 API Key、宿主密钥或账本观测与校正记录。"),
					h(M.Group, { justify: "flex-end" },
						h(M.Button, { size: "xs", variant: "default", onClick: () => setResetConfirm(false) }, "取消"),
						h(M.Button, { size: "xs", color: "red", onClick: resetConfig, disabled: configPending }, "确认恢复设置"),
					),
				),
			),
			status.startsWith("save-error:") ? h(M.Alert, { color: "red", title: "保存或读取未完成", p: "sm" },
				h(M.Stack, { gap: "xs" },
					h(M.Text, { size: "xs" }, status.slice("save-error:".length).trim()),
					h(M.Text, { size: "xs" }, "本页改动仍保留，请勿关闭。只有服务端确认返回后才视为已保存。"),
					h(M.Button, { size: "xs", variant: "light", onClick: () => pendingSave.current ? flushSave() : reloadConfig() }, pendingSave.current ? "重试保存" : "重试读取"),
				),
			) : null,
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
					h(M.Tabs.Tab, { value: "bubbles" }, "气泡与文案"),
					h(M.Tabs.Tab, { value: "balance" }, "余额 API"),
					h(M.Tabs.Tab, { value: "ledger" }, "账本与预警"),
					h(M.Tabs.Tab, { value: "tasks" }, "任务提醒"),
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
							{ title: "点击音效", description: "面板内点击播放原版橡皮鸭叫；关闭后停止播放。" },
							h(Toggle, {
								label: "开启点击音效",
								description: "默认开启，音量 60%",
								checked: sound.enabled !== false,
								onChange: (value) => patchSound({ enabled: value }),
							}),
							h(SliderRow, {
								label: "音量",
								value: sound.volume,
								min: 0,
								max: 1,
								step: 0.05,
								onChange: (value) => patchSound({ volume: value }),
								format: (value) => `${Math.round(value * 100)}%`,
							}),
							h(
								M.Text,
								{ size: "xs", c: "dimmed" },
								"当前宿主的浮层仅支持指针中继，无法可靠解锁音频，插件在浮层不播放或积压点击声。面板内真实点击可解锁原版鸭叫；此开关和音量只影响声音，不影响动画。",
							),
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

				/* ---------------------------------------------------- 气泡与文案 */
				h(M.Tabs.Panel, { value: "bubbles", pt: "sm" },
					h(BubbleSettings, { value: config.bubbles, onChange: (patch) => commit({ bubbles: patch }) }),
				),

				/* ---------------------------------------------------- 账本与预警 */
				h(M.Tabs.Panel, { value: "ledger", pt: "sm" },
					h(LedgerSettings, { accounting: config.accounting, alerts: config.alerts, configPending,
						onAccountingChange: (patch) => commit({ accounting: patch }),
						onAlertsChange: (patch) => commit({ alerts: patch }),
					}),
				),

				/* ---------------------------------------------------- 任务提醒 */
				h(M.Tabs.Panel, { value: "tasks", pt: "sm" },
					h(TaskSettings, { value: config.tasks, onChange: (patch) => commit({ tasks: patch }) }),
				),

				/* ---------------------------------------------------- 余额 API */
				h(
					M.Tabs.Panel,
					{ value: "balance", pt: "sm" },
					h(BalanceApiSettings, {
						balance: config.balance,
						secret: secrets.find((entry) => entry?.key === BALANCE_SECRET_KEY),
						keyDraft: draftSecret[BALANCE_SECRET_KEY] ?? "",
						keyNotice,
						busy: balanceBusy,
						result: balanceResult,
						configPending,
						onPatch: patchBalance,
						onPatchCustom: patchBalanceCustom,
						onKeyDraft: (value) => {
							setDraftSecret((previous) => ({ ...previous, [BALANCE_SECRET_KEY]: value }));
							setKeyNotice(undefined);
						},
						onSaveKey: () => saveSecret(BALANCE_SECRET_KEY),
						onDeleteKey: () => clearSecret(BALANCE_SECRET_KEY),
						onQuery: testBalance,
					}),
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
								"桌面级置顶浮层：插件浮层只能在宿主提供的面板或浮层矩形内活动，不是独立桌面窗口。",
								"多显示器漫游与 DPI 适配：由宿主面板决定，插件不自行接管。",
								"<video>/<audio> 播放：iframe 的 media-src 为 'none'，所有表现只能走 <img> 与 WebAudio。",
								"语音合成与识别：宿主没有对应 API。",
								"LLM 闲聊与长期记忆：本版只使用固定文案，不调用模型。",
								"逐轮费用与等待回答状态：宿主未提供足够信号，不会把余额变化或普通消息推断为逐轮费用、等待你回答。",
								"宿主余额缓存与叙述者余额匹配：本版不读取 NarraFork 的 provider-balances 缓存、日志或叙述者上下文，余额只来自你自己配置的那一个 HTTPS 余额 API；也没有多供应商轮播。",
								"DSH 账号登录方式的余额：没有可借用的凭据服务，只能由你填 API Key。",
							].map((item, index) => h(M.Text, { key: index, size: "xs", c: "dimmed" }, `· ${item}`)),
						),
						h(
							Section,
							{ title: "数据" },
							h(
								M.Text,
								{ size: "xs", c: "dimmed" },
								"配置、余额观测账本与预警规则存在插件自己的 storage（按插件 id 隔离）；API Key 由宿主 secret vault 保管（customApiKey，插件只写不读，任何界面都不回显）；人工校正记录随账本保存，不写入宿主账单。卸载插件默认保留这些数据，删除 ~/.narrafork/plugins/data/cn.mcd7.neglectdream.dsh-pet 即可彻底清除。",
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
