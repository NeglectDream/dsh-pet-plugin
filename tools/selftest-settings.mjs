#!/usr/bin/env node
/* Dependency-free settings regressions: whole-file syntax, the single-API balance
 * schema, copy scope, and a fake-React render of the balance panel with simulated
 * typing. No browser, no real DOM, no network, no Mantine, no packages. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "ui/settings.js"), "utf8");
const css = fs.readFileSync(path.join(root, "ui/settings.css"), "utf8");
let passed = 0;
function test(name, run) {
	try { run(); passed += 1; console.log(`ok ${passed} - ${name}`); }
	catch (error) { console.error(`FAIL - ${name}`); throw error; }
}

/* -------------------------------------------------------------------------- */
/* A tiny hook renderer: enough for Section / SliderRow / BalanceApiSettings.  */
/* -------------------------------------------------------------------------- */

class MiniRenderer {
	constructor(Component) {
		this.Component = Component;
		this.slots = new Map();
		this.pending = [];
		this.dirty = false;
		this.current = null;
		this.index = 0;
	}

	render(props) {
		this.props = props;
		for (let pass = 0; pass < 32; pass += 1) {
			this.dirty = false;
			this.pending = [];
			this.tree = this.renderElement({ type: this.Component, props }, "root");
			let guard = 0;
			while (this.pending.length > 0) {
				const queue = this.pending;
				this.pending = [];
				for (const effect of queue) effect();
				assert.ok(++guard < 64, "effect cascade settles");
			}
			if (!this.dirty) return this.tree;
		}
		throw new Error("render loop did not settle");
	}

	renderElement(element, at) {
		if (element === null || element === undefined || element === false || element === true) return null;
		if (Array.isArray(element)) return element.map((child, index) => this.renderElement(child, `${at}/${index}`));
		if (typeof element === "string" || typeof element === "number") return { type: "#text", text: String(element), props: {} };
		if (typeof element.type === "function") {
			const previous = this.current;
			let slots = this.slots.get(at);
			if (!slots) { slots = []; this.slots.set(at, slots); }
			this.current = { slots };
			this.index = 0;
			const output = element.type(element.props ?? {});
			this.current = previous;
			return { type: `Component(${element.type.name || "anonymous"})`, props: element.props ?? {}, children: this.renderElement(output, `${at}/out`) };
		}
		const props = element.props ?? {};
		return { type: String(element.type), props, children: this.renderElement(props.children ?? null, `${at}/c`) };
	}

	/* Hook slots are positional per component instance path, like React's list. */
	hookSlot(read) {
		const index = this.index++;
		const slots = this.current.slots;
		if (!(index in slots)) slots[index] = read ? { value: read() } : {};
		return slots[index];
	}

	useState(initial) {
		const slot = this.hookSlot(() => ({ value: typeof initial === "function" ? initial() : initial }));
		return [slot.value, (next) => {
			const value = typeof next === "function" ? next(slot.value) : next;
			if (!Object.is(value, slot.value)) { slot.value = value; this.dirty = true; }
		}];
	}

	useEffect(fn, deps) {
		const slot = this.hookSlot();
		const changed = !("deps" in slot) || !deps || !slot.deps
			|| deps.length !== slot.deps.length || deps.some((dep, index) => !Object.is(dep, slot.deps[index]));
		if (changed) { slot.deps = deps; this.pending.push(fn); }
	}

	useRef(initial) { return this.hookSlot(() => ({ current: initial })); }

	useCallback(fn, deps) {
		const slot = this.hookSlot();
		const changed = !("deps" in slot) || !deps || !slot.deps
			|| deps.length !== slot.deps.length || deps.some((dep, index) => !Object.is(dep, slot.deps[index]));
		if (changed) { slot.deps = deps; slot.value = fn; }
		return slot.value;
	}

	useMemo(fn, deps) {
		const slot = this.hookSlot();
		const changed = !("deps" in slot) || !deps || !slot.deps
			|| deps.length !== slot.deps.length || deps.some((dep, index) => !Object.is(dep, slot.deps[index]));
		if (changed) { slot.deps = deps; slot.value = fn(); }
		return slot.value;
	}
}

function flatten(node, out = []) {
	if (!node) return out;
	if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out; }
	out.push(node);
	if (node.children) flatten(node.children, out);
	return out;
}
const jsonOf = (tree) => JSON.stringify(flatten(tree));
// Values built inside the vm carry that realm's Object prototype, so compare them
// after a JSON round-trip instead of strict prototype equality.
const plain = (value) => JSON.parse(JSON.stringify(value));
const nodesOf = (tree, type) => flatten(tree).filter((node) => node.type === type);
const labeled = (tree, label) => flatten(tree).find((node) => node.props && node.props.label === label);
const button = (tree, text) => nodesOf(tree, "Mantine.Button").find((node) => node.props.children === text);

/* -------------------------------------------------------------------------- */
/* Load the real file in a vm with fakes, then grab the balance component.     */
/* -------------------------------------------------------------------------- */

function loadSettings() {
	const mount = { innerHTML: "", dataset: {}, append() {}, querySelector() { return null; } };
	const document = {
		getElementById() { return null; },
		body: { appendChild() { return mount; } },
		createElement() { return { dataset: {}, append() {} }; },
		documentElement: { dataset: {} },
	};
	let active = null;
	const createElement = (type, props, ...children) => {
		const merged = { ...(props ?? {}) };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { type, props: merged };
	};
	const React = {
		createElement,
		useState: (initial) => active.useState(initial),
		useEffect: (fn, deps) => active.useEffect(fn, deps),
		useRef: (initial) => active.useRef(initial),
		useCallback: (fn, deps) => active.useCallback(fn, deps),
		useMemo: (fn, deps) => active.useMemo(fn, deps),
	};
	const MantineCore = new Proxy({}, { get: (_, name) => `Mantine.${String(name)}` });
	const context = vm.createContext({
		console,
		document,
		Intl, URL, URLSearchParams, JSON, Promise, Date, Math, Object, Array, String, Number, Boolean, Set, Map, Error,
		MutationObserver: class { observe() {} disconnect() {} },
		setTimeout, clearTimeout,
		__nfPluginRuntime: {
			React,
			MantineCore,
			theme: {},
			ReactDOMClient: { createRoot: () => ({ render() {} }) },
		},
	});
	vm.runInContext(`${source}\nglobalThis.__nfSettingsTest = { BalanceApiSettings, balanceUrlError, balancePathError, balanceFailureText, BALANCE_CURRENCIES, BALANCE_CURRENCY_DATA, BALANCE_SECRET_KEY, TaskSettings };`, context);
	const api = context.__nfSettingsTest;
	assert.ok(api && typeof api.BalanceApiSettings === "function", "component exported from the vm");
	return { api, setActive: (value) => { active = value; } };
}

const loaded = loadSettings();
const { api } = loaded;

class Panel {
	constructor(overrides = {}) {
		this.calls = { patch: [], custom: [], keyDraft: [], saveKey: 0, deleteKey: 0, query: 0 };
		this.props = {
			balance: { refreshMinutes: 30, thresholds: [20, 40, 60, 80, 100], custom: { url: "", totalPath: "", usedPath: "", currency: "POINTS" } },
			secret: { key: "customApiKey", configured: false, known: true },
			keyDraft: "",
			keyNotice: undefined,
			busy: false,
			result: undefined,
			configPending: false,
			onPatch: (patch) => this.calls.patch.push(patch),
			onPatchCustom: (patch) => this.calls.custom.push(patch),
			onKeyDraft: (value) => { this.props.keyDraft = value; this.calls.keyDraft.push(value); },
			onSaveKey: () => { this.calls.saveKey += 1; },
			onDeleteKey: () => { this.calls.deleteKey += 1; },
			onQuery: () => { this.calls.query += 1; },
			...overrides,
		};
		this.renderer = new MiniRenderer(api.BalanceApiSettings);
		this.draw();
	}

	draw() {
		loaded.setActive(this.renderer);
		this.tree = this.renderer.render(this.props);
		this.json = jsonOf(this.tree);
		return this.tree;
	}

	type(label, value) {
		const field = labeled(this.tree, label);
		assert.ok(field, `field ${label} exists`);
		field.props.onChange({ currentTarget: { value } });
		return this.draw();
	}

	click(text) {
		const target = button(this.tree, text);
		assert.ok(target, `button ${text} exists`);
		target.props.onClick();
		return this.draw();
	}

	field(label) { return labeled(this.tree, label); }
	slider() { return nodesOf(this.tree, "Mantine.Slider")[0]; }
	select() { return nodesOf(this.tree, "Mantine.Select")[0]; }
}

/* -------------------------------------------------------------------------- */
/* 1. Syntax and static scope                                                 */
/* -------------------------------------------------------------------------- */

test("ui/settings.js parses as one classic script (vm.Script)", () => {
	new vm.Script(source, { filename: "ui/settings.js" });
});

test("host/narrator balance machinery is gone from the settings source", () => {
	for (const banned of ["hostProviders", "hostProvidersStatus", "hostProviderState", "providerSelectionId",
		"narratorBalances", "NarratorBalanceSettings", "validNarratorBalanceMappings", "validHostProviderSelectionId",
		"loadBalanceProviders", "saveNarratorBinding", "pet-balance-providers", "providerOptions", "hostProvidersError"]) {
		assert.ok(!source.includes(banned), `settings.js must not reference ${banned}`);
	}
	assert.ok(!css.includes("pet-settings-narrator-map"), "narrator mapping styles removed");
	assert.ok(css.includes("pet-settings-key-row"), "API key row style present");
});

test("balance refresh is the fixed single-API call and carries no provider id", () => {
	assert.ok(source.includes('SDK.callSafe("pet-balance-refresh", { force: true })'), "force-only refresh call");
	assert.ok(!/pet-balance-refresh",\s*\{[^}]*providerId/.test(source), "refresh input has no providerId");
	assert.ok(!source.includes("pet-balance-providers"), "removed command is never called");
});

test("narrator context is only probed by the task tab, never by the balance tab", () => {
	const contextUses = source.split("getContextSafe").length - 1;
	assert.equal(contextUses, 2, "task tab still probes its own context twice (typeof + call)");
	const taskAt = source.indexOf("function TaskSettings");
	assert.ok(taskAt > 0, "TaskSettings exists");
	const firstUser = source.indexOf("getContextSafe");
	assert.ok(firstUser > taskAt, "every getContextSafe reference lives in TaskSettings");
	const balanceAt = source.indexOf("function BalanceApiSettings");
	const balanceEnd = source.indexOf("function App()");
	assert.ok(balanceAt > 0 && balanceEnd > balanceAt, "balance component is delimited");
	assert.ok(!source.slice(balanceAt, balanceEnd).includes("getContextSafe"), "balance panel has no context probe");
	assert.ok(!source.slice(balanceAt, balanceEnd).includes("narrator"), "balance panel mentions no narrator");
});

test("only customApiKey is listed, saved and deleted", () => {
	assert.ok(source.includes('const BALANCE_SECRET_KEY = "customApiKey";'), "single secret constant");
	assert.ok(source.includes("keys.filter((entry) => entry && entry.key === BALANCE_SECRET_KEY)"), "secret list filtered");
	assert.equal(source.split("secrets.set(").length - 1, 1, "one secrets.set call site");
	assert.equal(source.split("secrets.delete(").length - 1, 1, "one secrets.delete call site");
	for (const legacy of ["deepseek", "opencode", "commandcode", "DEEPSEEK", "OPENCODE"]) {
		assert.ok(!source.includes(legacy), `legacy provider ${legacy} removed`);
	}
});

test("copy no longer says 余额来源 and states the fixed GET + Bearer contract", () => {
	assert.ok(!source.includes("余额来源"), "old wording replaced");
	assert.ok(source.includes('"余额 API"'), "tab/panel title renamed");
	assert.ok(source.includes("固定 HTTPS GET"), "fixed method stated");
	assert.ok(source.includes("Authorization: Bearer"), "bearer placement stated");
	assert.ok(source.includes("不会自动转移"), "old built-in keys are not copied");
	assert.ok(source.includes("旧版内置服务商的密钥不会自动转移到这里"), "transfer note is explicit");
});

test("currency options are the supported manual units, POINTS first", () => {
	const expected = ["POINTS", "CNY", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "HKD", "SGD", "KRW", "INR", "TWD", "NZD", "RUB", "BRL"];
	assert.deepEqual([...api.BALANCE_CURRENCIES], expected);
	assert.equal(api.BALANCE_CURRENCY_DATA.length, expected.length);
	assert.equal(api.BALANCE_CURRENCY_DATA[0].value, "POINTS");
	assert.ok(api.BALANCE_CURRENCY_DATA[0].label.includes("积分"));
	assert.equal(api.BALANCE_SECRET_KEY, "customApiKey");
});

/* -------------------------------------------------------------------------- */
/* 2. Input validation (safe pure input paths, HTTPS only, never a key in URL) */
/* -------------------------------------------------------------------------- */

test("URL validation accepts only a plain HTTPS endpoint", () => {
	const { balanceUrlError: urlError } = api;
	assert.equal(urlError(""), "");
	assert.equal(urlError("https://api.example.com/v1/balance"), "");
	assert.equal(urlError("https://api.example.com:8443/b?x=1"), "");
	assert.match(urlError("http://api.example.com/balance"), /只支持 https/);
	assert.match(urlError("ftp://api.example.com"), /只支持 https/);
	assert.match(urlError("api.example.com/balance"), /只支持 https/);
	assert.match(urlError("https://exa mple.com"), /空白/);
	assert.match(urlError("https://user:pass@example.com/balance"), /用户名或密码/);
	assert.match(urlError("https://example.com/balance?api_key=secret"), /密钥参数/);
	assert.match(urlError("https://example.com/balance?token=abc"), /密钥参数/);
	assert.match(urlError("https://"), /主机名|格式/);
	assert.match(urlError(`https://example.com/${"a".repeat(600)}`), /过长/);
});

test("field paths are dot-separated keys, never expressions", () => {
	const { balancePathError: pathError } = api;
	assert.equal(pathError("", false), "");
	assert.match(pathError("", true), /必填/);
	assert.equal(pathError("data.balance", true), "");
	assert.equal(pathError("data.wallet-1.remaining_amount", true), "");
	assert.match(pathError("data..balance", true), /点分隔/);
	assert.match(pathError("../etc/passwd", true), /点分隔/);
	assert.match(pathError("data[0].balance", true), /点分隔/);
	assert.match(pathError("data.balance;rm -rf /", true), /点分隔/);
	assert.match(pathError(`a.${"b".repeat(200)}`, true), /过长/);
});

test("backend failures become short readable messages", () => {
	const { balanceFailureText: fail } = api;
	assert.match(fail({ kind: "shape_mismatch", message: "long provider body" }), /响应字段不匹配/);
	assert.match(fail({ kind: "missing_secret" }), /尚未配置/);
	assert.match(fail({ kind: "auth", message: "HTTP 401" }), /鉴权失败/);
	assert.match(fail({ kind: "network" }), /网络请求失败/);
	assert.match(fail({ kind: "timeout" }), /超时/);
	assert.match(fail({ kind: "invalid_json" }), /合法 JSON/);
	assert.match(fail({ kind: "weird", message: "boom" }), /boom/);
	assert.equal(fail(undefined), "余额查询失败。");
	assert.ok(fail({ kind: "weird", message: "x".repeat(400) }).length < 200, "message stays short");
});

/* -------------------------------------------------------------------------- */
/* 3. Rendering the balance panel                                             */
/* -------------------------------------------------------------------------- */

test("a fresh empty config renders one API form, no error page and no selector", () => {
	const panel = new Panel();
	const section = flatten(panel.tree).find((node) => node.props?.title === "余额 API");
	assert.ok(section, "balance API section is present");
	assert.equal(flatten(panel.tree).filter((node) => node.props?.title === "余额 API").length, 1, "exactly one balance section");
	assert.equal(nodesOf(panel.tree, "Mantine.SegmentedControl").length, 0, "no host/manual source switch");
	assert.equal(panel.field("API URL").props.value, "");
	assert.equal(panel.field("API URL").props.error, undefined, "empty default URL is not an error");
	assert.equal(panel.field("剩余额度字段路径（totalPath，必填）").props.error, undefined, "untouched empty path is not an error");
	assert.equal(panel.select().props.value, "POINTS", "currency defaults to POINTS");
	assert.equal(panel.select().props.data.length, 17, "currency select lists every supported unit");
	assert.equal(panel.field("API Key").props.value, "", "key field starts empty and is never prefilled");
	assert.match(panel.json, /customApiKey 未配置/);
	assert.match(panel.json, /不会回显/, "key is write-only in the copy");
	assert.equal(button(panel.tree, "删除 Key"), undefined, "delete only offered when configured");
	const query = button(panel.tree, "立即查询");
	assert.ok(query, "query button exists");
	assert.equal(query.props.disabled, false, "query allowed before any config is saved");
});

test("typing an unsafe URL never reaches the config", () => {
	const panel = new Panel();
	panel.type("API URL", "http://api.example.com/balance");
	assert.deepEqual(plain(panel.calls.custom), [], "non-HTTPS value is not saved");
	assert.match(panel.field("API URL").props.error, /只支持 https/);
	assert.equal(button(panel.tree, "立即查询").props.disabled, true, "query blocked while the draft is invalid");

	panel.type("API URL", "https://example.com/balance?api_key=leak");
	assert.deepEqual(plain(panel.calls.custom), [], "key in URL is not saved");
	assert.match(panel.field("API URL").props.error, /密钥参数/);

	panel.type("API URL", "https://api.example.com/balance");
	assert.deepEqual(plain(panel.calls.custom), [{ url: "https://api.example.com/balance" }], "valid URL is saved");
	assert.equal(panel.field("API URL").props.error, undefined);
	assert.equal(button(panel.tree, "立即查询").props.disabled, false);
});

test("response field paths and the currency are saved explicitly", () => {
	const panel = new Panel();
	panel.type("剩余额度字段路径（totalPath，必填）", "data..balance");
	assert.deepEqual(plain(panel.calls.custom), [], "invalid path is not saved");
	assert.match(panel.field("剩余额度字段路径（totalPath，必填）").props.error, /点分隔/);

	panel.type("剩余额度字段路径（totalPath，必填）", "data.balance");
	assert.deepEqual(plain(panel.calls.custom.at(-1)), { totalPath: "data.balance" });

	panel.type("已用额度字段路径（usedPath，可选）", "data.used");
	assert.deepEqual(plain(panel.calls.custom.at(-1)), { usedPath: "data.used" });
	assert.equal(panel.field("已用额度字段路径（usedPath，可选）").props.error, undefined);

	panel.select().props.onChange("CNY");
	assert.deepEqual(plain(panel.calls.custom.at(-1)), { currency: "CNY" });
	assert.equal(panel.select().props.value, "POINTS", "saved value comes from config, not the click");
});

test("refresh period and query button only use the single endpoint", () => {
	const panel = new Panel();
	panel.slider().props.onChange(45);
	assert.deepEqual(plain(panel.calls.patch), [{ refreshMinutes: 45 }]);
	button(panel.tree, "立即查询").props.onClick();
	assert.equal(panel.calls.query, 1);
});

test("pending save disables the immediate query with an explanation", () => {
	const panel = new Panel({ configPending: true });
	const query = button(panel.tree, "立即查询");
	// A fake renderer cannot emulate Mantine swallowing clicks on a disabled
	// button, so only the disabled flag is asserted here.
	assert.equal(query.props.disabled, true, "query disabled while a save is queued");
	assert.match(panel.json, /有改动正在保存/);
});

test("busy state disables the query and shows a spinner flag", () => {
	const panel = new Panel({ busy: true });
	assert.equal(button(panel.tree, "立即查询").props.disabled, true);
	assert.equal(button(panel.tree, "立即查询").props.loading, true);
});

test("saved config is reflected: currency, paths, key status and result text", () => {
	const panel = new Panel({
		balance: { refreshMinutes: 15, thresholds: [20, 40, 60, 80, 100], custom: { url: "https://api.example.com/balance", totalPath: "data.remaining", usedPath: "data.used", currency: "USD" } },
		secret: { key: "customApiKey", configured: true, known: true },
		result: { tone: "ok", text: "12.34 USD · 账本账户 1 个" },
	});
	assert.equal(panel.field("API URL").props.value, "https://api.example.com/balance");
	assert.equal(panel.field("剩余额度字段路径（totalPath，必填）").props.value, "data.remaining");
	assert.equal(panel.select().props.value, "USD");
	assert.match(panel.json, /customApiKey 已配置/);
	assert.match(panel.json, /12.34 USD · 账本账户 1 个/);
	assert.ok(button(panel.tree, "删除 Key"), "delete offered for a configured key");
	assert.equal(button(panel.tree, "立即查询").props.disabled, false);
});

test("POINTS explains that no money budget applies; a currency says otherwise", () => {
	const points = new Panel();
	assert.match(points.json, /POINTS（积分 \/ 未知单位）/);
	assert.match(points.json, /不计算货币消费/);
	const money = new Panel({
		balance: { refreshMinutes: 30, thresholds: [20, 40, 60, 80, 100], custom: { url: "", totalPath: "", usedPath: "", currency: "EUR" } },
	});
	assert.match(money.json, /当前单位 EUR/);
	assert.match(money.json, /才启用货币消费与金额预算/);
});

test("key draft, save and delete stay write-only", () => {
	const panel = new Panel();
	panel.type("API Key", "sk-test-value");
	assert.deepEqual(panel.calls.keyDraft, ["sk-test-value"]);
	assert.equal(panel.field("API Key").props.value, "sk-test-value", "typing keeps a local draft");
	panel.click("保存 Key");
	assert.equal(panel.calls.saveKey, 1);

	const configured = new Panel({ secret: { key: "customApiKey", configured: true, known: true } });
	configured.click("更换 Key");
	assert.equal(configured.calls.saveKey, 1, "configured key can be replaced");
	configured.click("删除 Key");
	assert.equal(configured.calls.deleteKey, 1, "configured key can be deleted");
	assert.equal(configured.field("API Key").props.value, "", "no existing key is ever shown");
});

test("key notices and failure alerts are rendered as short messages", () => {
	const panel = new Panel({ keyNotice: { tone: "ok", text: "API Key 已保存（不会回显）" } });
	assert.match(panel.json, /API Key 已保存/);
	const failed = new Panel({ result: { tone: "error", text: "鉴权失败（401\/403）：API Key 无效或没有权限。" } });
	assert.match(failed.json, /鉴权失败/);
	assert.match(failed.json, /余额 API/, "panel still explains the single source");
});
