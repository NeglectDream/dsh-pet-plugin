#!/usr/bin/env node
/* Dependency-free migration, layout and lifecycle regressions; no browser/RPC. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(fs.readFileSync(path.join(root, "ui/bubble-presets.json"), "utf8"));
const audit = JSON.parse(fs.readFileSync(path.join(root, "tools/bubble-source-audit.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "ui/bubbles.js"), "utf8");
const css = fs.readFileSync(path.join(root, "ui/bubbles.css"), "utf8");
const context = vm.createContext({ __PET_BUBBLE_PRESETS__: presets, setTimeout, clearTimeout, Intl, console });
vm.runInContext(`${source}\nglobalThis.kit = BubbleKit; globalThis.Content = BubbleContent; globalThis.Bubble = PetBubble;`, context);
const { kit: K, Content: C, Bubble } = context;
let passed = 0;
function test(name, run) { try { run(); passed += 1; console.log(`ok ${passed} - ${name}`); } catch (error) { console.error(`FAIL - ${name}`); throw error; } }
const sample = (remaining = "12.34", currency = "USD") => ({ ok: true, shape: "money", accounts: [{ accountId: "sample-account", providerId: "Example", currency, remaining, percent: 38.3 }] });
const textOf = (content) => content.modules.map((entry) => `${entry.label} ${entry.value} ${entry.unit}`).join("\n");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class Clock {
	nowValue = 1000; serial = 0; timers = new Map();
	now() { return this.nowValue; }
	setTimeout(fn, delay = 0) { const id = ++this.serial; this.timers.set(id, { fn, due: this.nowValue + delay }); return id; }
	clearTimeout(id) { this.timers.delete(id); }
	requestAnimationFrame(fn) { return this.setTimeout(() => fn(this.nowValue), 16); }
	cancelAnimationFrame(id) { this.clearTimeout(id); }
	jump(ms) { this.nowValue += ms; }
	advance(ms) {
		const target = this.nowValue + ms; let guard = 0;
		while (true) {
			const next = [...this.timers].sort((a, b) => a[1].due - b[1].due).find(([, item]) => item.due <= target);
			if (!next) break;
			assert.ok(++guard < 10000, "finite timer drain");
			this.nowValue = next[1].due; this.timers.delete(next[0]); next[1].fn();
		}
		this.nowValue = target;
	}
}
class Element {
	constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false; this.textContent = ""; this.classes = new Set(); this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)) }; }
	append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
	replaceChildren(...children) { this.children.forEach((child) => { child.parent = null; }); this.children = []; this.append(...children); }
	setAttribute(name, value) { this.attributes[name] = String(value); if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
	removeAttribute(name) { delete this.attributes[name]; if (name.startsWith("data-")) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; }
	addEventListener(type, fn) { this.listeners.set(type, fn); }
	removeEventListener(type) { this.listeners.delete(type); }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
	get isConnected() { return this.isRoot || Boolean(this.parent?.isConnected); }
	get offsetWidth() { throw new Error("layout read forbidden"); }
	get offsetHeight() { throw new Error("layout read forbidden"); }
	getBoundingClientRect() { throw new Error("layout read forbidden"); }
}
function domBubble(options = {}) {
	const doc = { hidden: false, listeners: new Map(), createElement(tag) { return new Element(tag, doc); }, createElementNS(_, tag) { return new Element(tag, doc); },
		addEventListener(type, fn) { doc.listeners.set(type, fn); }, removeEventListener(type) { doc.listeners.delete(type); } };
	const container = doc.createElement("div"); container.isRoot = true;
	const clock = new Clock();
	const bubble = new Bubble({ container, clock, snapshot: sample(), body: { left: 130, top: 260, width: 150, height: 100 }, viewport: { width: 500, height: 420 }, ...options });
	return { bubble, clock, container, doc };
}

test("fixed repository commit and source license are pinned", () => {
	assert.equal(presets.source.repo, "MeteorNOX/DeepSeek-Balance-Whale-Widget");
	assert.equal(presets.source.commit, "5247dd6813d6e4430728f39ccc63d43cda046022");
	assert.equal(audit.commit, presets.source.commit); assert.ok(presets.source.license);
});
test("every original default record is migrated with weight and styling", () => {
	assert.equal(presets.random.length, audit.counts.defaultRecords);
	assert.ok(presets.random.length >= 45 && presets.random.length <= 55);
	assert.equal(new Set(presets.random.map((item) => item.id)).size, presets.random.length);
	for (const item of presets.random) { assert.ok(item.text.trim()); assert.ok(item.weight > 0); assert.equal(typeof item.style.fontSize, "number"); assert.equal(typeof item.style.bold, "boolean"); }
	assert.equal(hash(presets.random), audit.randomSha256);
});
test("same-text style variants and uncovered historical lines are preserved", () => {
	assert.ok(presets.random.length > new Set(presets.random.map((item) => item.text)).size);
	assert.equal(presets.history.length, audit.counts.historySupplement);
	assert.ok(presets.history.length > 0);
	assert.ok(presets.history.every((entry) => !presets.random.some((item) => item.text === entry.text)));
});
test("classic geometry uses exact source viewBox, white and blue stroke", () => {
	assert.equal(presets.geometry.viewBox, "0 0 1026 700"); assert.equal(presets.geometry.strokeWidth, 18); assert.equal(presets.geometry.paths.length, 3);
	assert.equal(hash(presets.geometry), audit.geometrySha256);
	assert.ok(source.includes('"#fff"')); assert.ok(source.includes('"#203170"'));
});
test("image records are explicitly excluded rather than creating empty phrases", () => {
	assert.ok(Array.isArray(presets.excluded)); assert.ok(presets.excluded.length > 0);
	assert.ok(presets.excluded.every((item) => item.reason));
	assert.ok(presets.random.every((item) => item.text.trim() && !item.image && !item.src));
});
test("system template categories all have non-empty content", () => {
	for (const id of ["balance", "gift", "topup", "balance-low", "budget-warning", "turn-cost", "turn-cost-unavailable", "permission-wait", "question-wait", "task-done", "task-error", "no-data", "loading", "stale", "error"]) assert.ok(presets.templates.some((entry) => entry.id === id && entry.text.trim()), id);
});
test("source weights are unchanged without overrides", () => {
	assert.equal(JSON.stringify(K.randomPool().map((item) => [item.id, item.weight])), JSON.stringify(presets.random.map((item) => [item.id, item.weight])));
});
test("all records sharing previous text are excluded from the next draw", () => {
	const previous = presets.random[0].text;
	for (let i = 0; i <= 100; i += 1) assert.notEqual(C.random([], () => i / 100, previous).text, previous);
});
test("zero weight disables a record and all-zero pool stays silent", () => {
	const overrides = presets.random.map((entry) => ({ id: entry.id, weight: 0 })); assert.equal(C.random(overrides), null);
});
test("overrides are bounded text/weight only and cannot inject styling", () => {
	const entry = presets.random[0]; const pool = K.randomPool([{ id: entry.id, text: "<img src=x onerror=alert(1)>", weight: 2, style: { gradient: "url(javascript:x)" } }]);
	assert.equal(pool[0].text, "<img src=x onerror=alert(1)>"); assert.equal(pool[0].style.gradient, K.safeStyle(entry.style).gradient);
});
test("template replacement is own-property-only and never evaluates markup", () => {
	const values = Object.create({ secret: "bad" }); values.name = "<script>bad</script>";
	assert.equal(K.interpolate("{name}/{secret}/{missing}", values), "<script>bad</script>/—/—");
});
test("style allowlist strips arbitrary CSS and clamps font size", () => {
	const style = K.safeStyle({ fontSize: 9999, bold: "yes", gradient: "url(https://bad)" });
	assert.equal(style.fontSize, 80); assert.equal(style.bold, false); assert.equal(style.gradient, null);
});
test("amount formatting retains exact fixed-point precision and real zero", () => {
	assert.equal(K.formatAmount("0", "USD"), "0 USD"); assert.equal(K.formatAmount("0.12345678", "CNY"), "0.12345678 CNY");
	assert.equal(K.formatAmount(null), "—"); assert.equal(K.formatAmount(""), "—"); assert.equal(K.formatAmount("12.34000000"), "12.34");
});
test("single API balance shows only explicit remaining and used fields", () => {
	const content = C.balance({ ok: true, shape: "money", accounts: [{ accountId: "api-account", providerId: "legacy-provider", currency: "USD", remaining: "12.34", used: "4.00", granted: "2.00", toppedUp: "8.00", total: "20.00", percent: 38.3 }] });
	const text = textOf(content);
	assert.match(text, /余额 12\.34 USD/); assert.match(text, /已用 4\.00 USD/);
	assert.doesNotMatch(text, /赠金|充值|20\.00|38\.3|%|legacy-provider/);
});
test("multi-account snapshots are projected to one account", () => {
	const snap = sample(); snap.accounts.push({ providerId: "Other", currency: "CNY", remaining: "8" });
	const mains = C.balance(snap).modules.filter((m) => m.main); assert.equal(mains.length, 1); assert.equal(mains[0].unit, "USD");
	assert.doesNotMatch(textOf(C.balance(snap)), /8 CNY/);
});
test("legacy percent and unlimited fields do not invent API values", () => {
	const content = C.balance({ ok: true, shape: "money", accounts: [{ currency: "USD", remaining: "12.34", percent: 38.3, unlimited: true }] });
	assert.match(textOf(content), /余额 12\.34 USD/); assert.doesNotMatch(textOf(content), /38\.3|%|不限/);
});
test("points are shown as a number and never get a fabricated ratio", () => {
	const content = C.balance({ ok: true, shape: "points", accounts: [{ shape: "points", currency: "POINTS", remaining: 0, percent: null }] });
	assert.ok(content.modules.some((m) => m.main && m.value === "0")); assert.ok(!content.modules.some((m) => m.key.endsWith(":percent")));
});
test("loading, missing, stale and error do not look like a fresh zero balance", () => {
	assert.equal(C.balance(null).status, "missing"); assert.equal(C.balance({ loading: true }).status, "loading");
	const content = C.balance({ ...sample(), ok: false, stale: true, error: { message: "连接失败" } });
	assert.equal(content.status, "stale"); assert.match(textOf(content), /旧数据/); assert.match(textOf(content), /12.34/);
});
test("daily ledger shows today.spend, not the lifetime observed total", () => {
	const content = C.balance(sample(), { accounts: [{ accountId: "sample-account", currency: "USD", observedSpend: "99", today: { spend: "2" } }] });
	assert.equal(content.modules.find((entry) => entry.label.endsWith("今日已观测消费")).value, "2.00");
});
test("long text paginates without dropping any original characters", () => {
	const text = "这是很长的一句话，换页不能丢字。\n".repeat(25) + "尾声";
	const pages = K.paginateText(text, { width: 90, height: 45, fontSize: 12 }); assert.ok(pages.length > 5); assert.equal(pages.map((page) => page.text).join(""), text);
});
test("currency and amount remain together across line/page boundaries", () => {
	const amount = "1234.5678 USD", text = `消费${amount}，余量0 CNY。`;
	const pages = K.paginateText(text, { width: 50, height: 15, fontSize: 12 }); assert.ok(pages.some((page) => page.text.includes(amount))); assert.equal(pages.map((page) => page.text).join(""), text);
});
test("emoji grapheme and surrogate pairs are never split", () => {
	const text = "鲸鱼\u{1f433}\u{1f469}\u200d\u{1f4bb}你好"; const pages = K.paginateText(text, { width: 15, height: 15, fontSize: 12 }); assert.equal(pages.map((page) => page.text).join(""), text);
	assert.ok(pages.some((page) => page.text.includes("\u{1f469}\u200d\u{1f4bb}")));
});
test("small pets and viewports degrade without sub-readable fonts", () => {
	const size = K.layout({ width: 30 }, { width: 130, height: 90 }, K.DEFAULT_CONFIG, { style: { fontSize: 24 } });
	assert.ok(size.width <= 122 && size.height <= 82); assert.ok(size.fontSize >= 12); assert.equal(size.compact, true);
});
test("placement is viewport bounded with a finite avoid-candidate set", () => {
	const viewport = { width: 400, height: 300 }, size = { width: 180, height: 123 };
	for (const body of [{ left: 0, top: 0, width: 100, height: 60 }, { left: 350, top: 250, width: 50, height: 50 }]) {
		const p = K.place(body, viewport, size, [{ left: 120, top: 0, width: 180, height: 120 }]); assert.ok(p.left >= 4 && p.top >= 4 && p.right <= 396 && p.bottom <= 296);
	}
});
test("manual scene sequence is balance then stable random then close", () => {
	const clock = new Clock(), session = new K.Session({ clock, snapshot: sample(), rng: () => 0 });
	session.interact(); assert.equal(session.scene, "balance"); session.interact(); assert.equal(session.scene, "random"); const text = session.content.text;
	session.updateData(sample("3")); assert.equal(session.scene, "random"); assert.equal(session.content.text, text); session.interact(); assert.equal(session.scene, "closed");
});
test("home click mode always returns to balance without reselecting random", () => { const s = new K.Session({ config: { clickMode: "home" }, snapshot: sample() }); s.interact(); s.interact(); assert.equal(s.scene, "balance"); s.destroy(); });
test("page progression happens before scene progression", () => { const s = new K.Session({ snapshot: sample() }); s.home(); s.pageCount = 2; s.advance(); assert.equal(s.pageIndex, 1); assert.equal(s.scene, "balance"); s.advance(); assert.equal(s.scene, "random"); s.destroy(); });
test("absolute expiry survives throttled timers and hidden restore", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home(); s.setVisible(false); clock.jump(6000); s.setVisible(true); assert.equal(s.scene, "closed"); assert.equal(clock.timers.size, 0);
});
test("zero duration holds until a user action or disable", () => {
	const clock = new Clock(), s = new K.Session({ clock, config: { durationMs: 0 }, snapshot: sample() }); s.home(); clock.advance(600000); assert.equal(s.scene, "balance"); assert.equal(s.deadline, 0); s.close(); assert.equal(clock.timers.size, 0);
});
test("changing duration to zero also updates the already open bubble", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home(); s.setConfig({ durationMs: 0 }); clock.advance(9000); assert.equal(s.scene, "balance"); s.destroy();
});
test("old timer callback cannot close a newer generation", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home(); const old = [...clock.timers.values()][0].fn; s.advance(); old(); assert.equal(s.scene, "random"); s.destroy();
});
test("same cached balance neither resets deadline nor emits new content", () => {
	const clock = new Clock(); let changes = 0; const snap = sample(); const s = new K.Session({ clock, snapshot: snap, onChange: () => changes++ });
	s.home(); const deadline = s.deadline, count = changes; clock.advance(800); s.updateData(snap); assert.equal(changes, count); assert.equal(s.deadline, deadline); s.destroy();
});
test("priority queue is bounded and low-priority chatter cannot replace manual content", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home();
	for (let i = 0; i < 20; i++) s.show(`notice ${i}`, { id: String(i), priority: 60 });
	assert.equal(s.scene, "balance"); assert.equal(s.queue.length, 8); s.show("permission", { id: "permission", priority: 90 }); assert.equal(s.queue[0].content.text, "permission");
	clock.advance(5000); assert.equal(s.content.text, "permission"); s.destroy();
});
test("same queued id deduplicates and expired notices are never replayed", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home(); s.show("old", { id: "a", priority: 60 }); s.show("new", { id: "a", priority: 60, expiresAt: 2000 }); assert.equal(s.queue.length, 1);
	clock.advance(6000); assert.equal(s.scene, "closed"); assert.equal(s.queue.length, 0);
});
test("hidden state drops automatic chatter instead of replaying on return", () => {
	const clock = new Clock(), s = new K.Session({ clock }); s.setVisible(false); assert.equal(s.show("chat", { automatic: true }), false); s.setVisible(true); assert.equal(s.scene, "closed");
	s.show("chat", { automatic: true }); s.setVisible(false); assert.equal(s.scene, "closed"); s.setVisible(true); assert.equal(s.scene, "closed");
});
test("disable and destroy clear every lifecycle timer and queued notice", () => {
	const clock = new Clock(), s = new K.Session({ clock, snapshot: sample() }); s.home(); s.show("queued", { priority: 1 }); s.setConfig({ enabled: false }); assert.equal(clock.timers.size, 0); assert.equal(s.queue.length, 0); assert.equal(s.scene, "closed");
	s.setConfig({ enabled: true }); s.home(); s.destroy(); assert.equal(clock.timers.size, 0); assert.equal(s.home(), false);
});
test("DOM adapter creates only three precise path hit targets", () => {
	const { bubble } = domBubble(); bubble.home(); assert.equal(bubble.shapeGroup.children.length, 3); assert.equal(bubble.svg.attributes.viewBox, "0 0 1026 700"); assert.match(css, /pointer-events: visiblePainted/); bubble.destroy();
});
test("position remains layout-read-free across repeated animation frames", () => {
	const { bubble } = domBubble(); bubble.home(); for (let i = 0; i < 120; i++) bubble.position({ left: 130 + i / 10, top: 260, width: 150, height: 100 }); assert.ok(bubble.rect); bubble.destroy();
});
test("mirroring affects the SVG group, not the text", () => {
	const { bubble } = domBubble({ body: { left: 0, top: 0, width: 70, height: 40 } }); bubble.home(); assert.match(bubble.shapeGroup.attributes.transform, /scale/); assert.equal(bubble.textElement.style.transform, undefined); bubble.destroy();
});
test("DOM replacement writes literal text, never HTML", () => {
	const { bubble, clock } = domBubble(); bubble.show("<img src=x onerror=alert(1)>", { durationMs: 0 }); clock.advance(400); assert.ok(bubble.textElement.children.some((node) => node.textContent.includes("<"))); assert.doesNotMatch(source, /\.innerHTML\s*=|eval\s*\(|new Function/); bubble.destroy();
});
test("page switch and close invalidate animation and transition callbacks", () => {
	const { bubble, clock } = domBubble(); bubble.home(); clock.advance(400); bubble.updateData(sample("1")); const old = [...clock.timers.values()].map((timer) => timer.fn); bubble.advance(); bubble.close();
	old.forEach((fn) => fn()); assert.equal(bubble.scene, "closed"); assert.equal(bubble.element.hidden, true); assert.equal(bubble.frames.size, 0); assert.equal(bubble.transitions.size, 0); bubble.destroy();
});
test("overlay is visual only; panel shape click advances", () => {
	const panel = domBubble(); panel.bubble.home(); const page = panel.bubble.pageIndex; panel.bubble.clickListener({ preventDefault() {}, stopPropagation() {} }); assert.ok(panel.bubble.pageIndex !== page || panel.bubble.scene !== "balance"); panel.bubble.destroy();
	const overlay = domBubble({ surface: "overlay" }); overlay.bubble.home(); overlay.bubble.clickListener({}); assert.equal(overlay.bubble.scene, "balance"); assert.equal(overlay.bubble.pageIndex, 0); overlay.bubble.destroy();
});
test("reduced motion disables transitions and amount animation work", () => {
	const { bubble, clock } = domBubble({ reducedMotion: true }); bubble.home(); clock.advance(20); bubble.updateData(sample("1")); assert.equal(bubble.frames.size, 0); assert.equal(bubble.element.dataset.reducedMotion, "true"); bubble.destroy();
});
test("DOM destroy removes listeners, nodes, timers and visual work", () => {
	const { bubble, clock, container, doc } = domBubble(); bubble.home(); bubble.destroy(); assert.equal(container.children.length, 0); assert.equal(doc.listeners.size, 0); assert.equal(clock.timers.size, 0); assert.equal(bubble.frames.size, 0);
});
test("every migrated original has the fixed upstream record hash", () => {
	assert.equal(hash(presets.random.map((entry) => entry.sourceOriginal)), audit.sourceRandomSha256);
	for (const entry of presets.random) {
		assert.equal(entry.text, entry.sourceOriginal.t); assert.equal(entry.weight, entry.sourceOriginal.w);
		assert.equal(entry.style.fontSize, entry.sourceOriginal.size ?? presets.source.defaultModuleSize);
		assert.equal(entry.style.bold, entry.sourceOriginal.bold === true); assert.equal(entry.style.gradient, entry.sourceOriginal.rgb || null);
	}
});
test("source-level font scale and italic are retained by the style allowlist", () => {
	const style = K.safeStyle(presets.random[47].style); assert.equal(style.fontUnit, "source-level"); assert.equal(style.fontSize, 8); assert.equal(style.italic, true); assert.equal(style.gradient, "macaron");
	assert.ok(K.layout({ width: 300 }, { width: 900, height: 700 }, K.DEFAULT_CONFIG, { style: K.safeStyle(presets.random[0].style) }).fontSize > K.layout({ width: 300 }, { width: 900, height: 700 }, K.DEFAULT_CONFIG, { style: K.safeStyle(presets.random[6].style) }).fontSize);
});
test("main visible SVG body is 1.35x pet width before readability fallback", () => {
	const size = K.layout({ width: 200 }, { width: 1000, height: 700 }, K.DEFAULT_CONFIG, { style: {} }); assert.ok(Math.abs(size.width * 746 / 1026 - 270) < 0.001);
});
test("display currency rounds exact decimals while preserving full numeric data", () => {
	assert.equal(K.displayAmount("123.45678901", "USD"), "123.46"); assert.equal(K.displayAmount("9999999999999.99500000", "CNY"), "10000000000000.00");
	assert.equal(K.displayAmount("-0.005", "USD"), "-0.01"); assert.equal(K.displayAmount(null, "USD"), "—");
	const main = C.balance(sample("0.12345678")).modules.find((entry) => entry.main); assert.equal(main.value, "0.12"); assert.equal(main.numeric, "0.12345678");
});
test("disabling autoChat does not disable automatically delivered system notices", () => {
	const clock = new Clock(), session = new K.Session({ clock, config: { autoChat: false } });
	assert.equal(session.show("permission", { id: "p", automatic: true, priority: 90 }), true); assert.equal(session.contentId, "p"); assert.equal(session.content.id, "p");
	assert.equal(session.show("chat", { automatic: true, priority: 10 }), false); assert.equal(session.content.text, "permission"); session.destroy();
});
test("hidden important notices survive only until their absolute expiry", () => {
	const clock = new Clock(), session = new K.Session({ clock, config: { autoChat: false } }); session.setVisible(false);
	session.show("permission", { id: "p", automatic: true, priority: 90, expiresAt: 10000 }); assert.equal(session.queue.length, 1);
	clock.jump(2000); session.setVisible(true); assert.equal(session.contentId, "p"); session.setVisible(false); clock.jump(8000); session.setVisible(true); assert.equal(session.scene, "closed");
});
test("changing autoChat while an important notice is open retains it", () => {
	const clock = new Clock(), session = new K.Session({ clock }); session.show("budget", { id: "budget", automatic: true, priority: 80 }); session.setConfig({ autoChat: false }); assert.equal(session.contentId, "budget"); session.close(); assert.equal(session.lastClosedId, "budget"); session.destroy();
});
test("small viewport balance pages retain every label, amount and currency", () => {
	const { bubble } = domBubble({ viewport: { width: 150, height: 130 }, body: { left: 55, top: 90, width: 40, height: 30 } }); bubble.home(); assert.equal(bubble.size.compact, true);
	const combined = bubble.pages.map((page) => page.text).join(""); assert.match(combined, /12.34 USD/); assert.doesNotMatch(combined, /赠金|充值|%/); assert.equal(bubble.size.fontSize, 12); bubble.destroy();
});
test("normal balance number and currency share a nowrap DOM wrapper", () => {
	const { bubble } = domBubble(); bubble.home(); const row = bubble.textElement.children.find((node) => node.className?.includes("is-main"));
	assert.ok(row.children.some((node) => node.className === "pet-thought-number" && node.children.length === 2)); assert.match(css, /pet-thought-number \{[^}]*white-space: nowrap/); bubble.destroy();
});
test("ledger display filters inactive accounts and mismatched currencies", () => {
	const content = C.balance(sample(), { accounts: [
		{ accountId: "sample-account", currency: "USD", today: { spend: "2" } },
		{ accountId: "old-account", currency: "USD", today: { spend: "88" } },
		{ accountId: "sample-account", currency: "CNY", today: { spend: "99" } },
	] });
	const entries = content.modules.filter((entry) => entry.key.startsWith("ledger:")); assert.equal(entries.length, 1); assert.equal(entries[0].value, "2.00");
});
test("browser timer fallbacks use their Window receiver, not the injected clock", () => {
	const browser = vm.createContext({ __PET_BUBBLE_PRESETS__: presets, Intl });
	vm.runInContext(`
		globalThis.timerTasks = new Map(); globalThis.timerSerial = 0;
		globalThis.setTimeout = function (fn, delay) { if (this !== globalThis) throw new TypeError("Illegal invocation"); const id = ++timerSerial; timerTasks.set(id, fn); return id; };
		globalThis.clearTimeout = function (id) { if (this !== globalThis) throw new TypeError("Illegal invocation"); timerTasks.delete(id); };
		globalThis.requestAnimationFrame = function (fn) { if (this !== globalThis) throw new TypeError("Illegal invocation"); return setTimeout(fn, 16); };
		globalThis.cancelAnimationFrame = function (id) { if (this !== globalThis) throw new TypeError("Illegal invocation"); clearTimeout(id); };
		${source}
		const clockOnlyNow = { now() { if (this !== clockOnlyNow) throw new TypeError("clock receiver"); return 1000; } };
		const session = new BubbleKit.Session({ clock: clockOnlyNow }); session.home(); session.advance(); session.destroy();
		const adapted = BubbleKit.clockAdapter(clockOnlyNow); const raf = adapted.requestAnimationFrame(() => {}); adapted.cancelAnimationFrame(raf);
	`, browser);
	assert.equal(browser.timerTasks.size, 0);
});
console.log(`\n${passed} bubble self-tests passed.`);
