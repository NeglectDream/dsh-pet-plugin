/**
 * No-dependency task bridge tests: node tools/selftest-tasks.mjs
 * Fixtures mirror the publicly verified host commit
 * 6007ca13581cd1f3db8756f28fa5e53f22bd148c, not an imagined event push API.
 * - asset-shell.ts: events methods each take one object; RPC results are unwrapped.
 * - plugin-ui-host.ts: poll result is PublicEvent[].
 * - plugins/protocol.ts: canonical poll result is {subscriptionId,events,hasMore}.
 * - plugin-event-gateway.ts: schema/data/resource envelope and attention mapping.
 * - event-bus.ts: tool statuses success/fail; attention reasons permission/done/error.
 * The VM loads production SDK and task-events source; no DOM or host installation.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { PLUGIN_DIR } from "./paths.mjs";

const [sdkSource, taskSource] = await Promise.all([
	fs.readFile(path.join(PLUGIN_DIR, "ui/sdk.js"), "utf8"),
	fs.readFile(path.join(PLUGIN_DIR, "ui/task-events.js"), "utf8"),
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 100; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const error = (code) => Object.assign(new Error(code), { code });
let eventNumber = 0;

function event(topic, data, extra = {}) {
	eventNumber += 1;
	return {
		schema: "narrafork.public-event", schemaVersion: 1,
		eventId: `evt_${eventNumber}`, occurredAt: "2026-11-10T12:00:00.000Z",
		topic: topic.startsWith("narrafork.") ? topic : `narrafork.narrator.${topic}`,
		eventClass: topic.includes("lifecycle") ? "lifecycle" : topic.includes("tool") ? "state" : "attention",
		redaction: "user_scoped", deliverySeq: eventNumber,
		resource: { type: "narrator", id: data.narratorId, narratorId: data.narratorId }, data,
		...extra,
	};
}
const permission = (narratorId = "n-a", requestId = "req-1", extra) => event("permission.changed", { narratorId, requestId, state: "pending" }, extra);
const attention = (reason, state = "raised", narratorId = "n-a", fields = {}) => event("attention", { narratorId, reason, state, ...fields });
const lifecycle = (status, narratorId = "n-a") => event("lifecycle", { narratorId, status });
const tool = (status, toolUseId = "tool-1", narratorId = "n-a", extra = {}) => event("tool.changed", { narratorId, toolUseId, toolName: "Bash", status, ...extra });
const control = (topic, subscriptionId) => event(`narrafork.events.${topic}`, { subscriptionId }, { resource: undefined, eventClass: "audit", redaction: "public" });

class Clock {
	constructor() { this.now = Date.parse("2026-11-10T12:00:00.000Z"); this.sequence = 0; this.jobs = new Map(); }
	setTimeout(fn, delay = 0) { const id = ++this.sequence; this.jobs.set(id, { at: this.now + Number(delay), fn }); return id; }
	clearTimeout(id) { this.jobs.delete(id); }
	async advance(ms) {
		const end = this.now + ms;
		for (let guard = 0; guard < 2000; guard += 1) {
			await flush();
			const next = [...this.jobs.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
			if (!next) { this.now = end; await flush(); return; }
			this.now = next[1].at;
			this.jobs.delete(next[0]);
			next[1].fn();
		}
		throw new Error("virtual clock exceeded bounded timer budget");
	}
}

const liveHarnesses = new Set();
function harness(options = {}) {
	const clock = new Clock();
	const calls = { contexts: 0, subscribe: [], poll: [], unsubscribe: [] };
	const notices = [], clears = [], states = [], queues = new Map(), scopes = new Map();
	let subscriptionNumber = 0;
	const listeners = new Map();
	const document = {
		currentScript: { src: "https://host.test/api/plugins/ui/demo/ui/stage.iife.js" },
		visibilityState: "visible",
		addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
		removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
	};
	const channel = {
		subscribe(input) {
			assert.equal(arguments.length, 1);
			assert.equal(this, channel, "SDK must preserve bridge method receiver");
			calls.subscribe.push(clone(input));
			const subId = `sub_${++subscriptionNumber}`;
			scopes.set(subId, input.scope.narratorId);
			const result = { subscriptionId: subId, mode: "live", delivery: { maxFrameBytes: 65536, queueEvents: 200, queueBytes: 131072, maxRatePerSecond: 50 } };
			return options.subscribe ? options.subscribe(input, result) : result;
		},
		poll(input) {
			assert.equal(arguments.length, 1);
			assert.equal(this, channel);
			assert.deepEqual(Object.keys(input).sort(), ["limit", "subscriptionId"]);
			calls.poll.push(clone(input));
			const queue = queues.get(input.subscriptionId) ?? [];
			const next = queue.length ? queue.shift() : [];
			if (next instanceof Error) throw next;
			return typeof next === "function" ? next(input) : next;
		},
		unsubscribe(input) {
			assert.equal(arguments.length, 1);
			assert.equal(this, channel);
			calls.unsubscribe.push(clone(input));
			return { unsubscribed: true };
		},
	};
	const bridge = {
		getContext() { calls.contexts += 1; return options.getContext ? options.getContext() : options.context ?? { contextVersion: 1, narrator: { id: "n-a" }, surface: { kind: "narrator-focus" } }; },
		events: channel,
		get onNotification() { throw new Error("task public events must never use onNotification"); },
		get queries() { throw new Error("must never enumerate narrators or read payloads"); },
		get commands() { throw new Error("must never approve permissions or invoke commands"); },
	};
	if (options.patch) options.patch(bridge);
	const sandbox = {
		console, URL, document, navigator: { userAgent: "task-test" },
		narrafork: options.noBridge ? undefined : bridge,
		setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
		Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
		get localStorage() { throw new Error("must not persist bindings globally"); },
		get sessionStorage() { throw new Error("this implementation keeps view bindings in memory"); },
	};
	vm.createContext(sandbox);
	vm.runInContext(`${sdkSource}\n${taskSource}\nglobalThis.testExports = { SDK, TaskEvents };`, sandbox, { filename: "task-events.vm.js" });
	const { SDK, TaskEvents } = sandbox.testExports;
	const task = new TaskEvents({
		config: options.config ?? { enabled: true },
		onNotice(value) { notices.push(clone(value)); options.onNotice?.(value); },
		onClear(value) { clears.push(value); options.onClear?.(value); },
		onState(value) { states.push(clone(value)); options.onState?.(value); },
	});
	const h = {
		SDK, task, calls, notices, clears, states, clock, bridge, document, listeners,
		state: () => clone(task.getState()),
		sub(narratorId = "n-a") { return [...scopes].filter(([, id]) => id === narratorId).at(-1)?.[0]; },
		enqueue(value, narratorId = "n-a") { const sub = h.sub(narratorId); assert.ok(sub, `no subscription for ${narratorId}`); if (!queues.has(sub)) queues.set(sub, []); queues.get(sub).push(value); },
		async start() { await task.start(); await flush(); return h; },
		async poll(value, narratorId = "n-a") { h.enqueue(value, narratorId); await clock.advance(1000); },
		async visibility(hidden) { document.visibilityState = hidden ? "hidden" : "visible"; for (const fn of listeners.get("visibilitychange") ?? []) fn(); await flush(); },
		destroy() { task.destroy(); liveHarnesses.delete(h); },
	};
	liveHarnesses.add(h);
	return h;
}

let passed = 0, failed = 0;
async function test(name, run) {
	try { await run(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
	catch (error) { failed += 1; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
	finally { for (const h of [...liveHarnesses]) h.destroy(); }
}

await test("SDK feature detection preserves object arguments and JSON sanitization", async () => {
	const h = harness();
	assert.equal((await h.SDK.getContextSafe()).ok, true);
	const api = h.SDK.events();
	await api.subscribe({ scope: { narratorId: "n-a" }, missing: undefined });
	assert.equal(Object.hasOwn(h.calls.subscribe[0], "missing"), false);
	await api.poll({ subscriptionId: "probe", limit: 1, missing: undefined });
	await api.unsubscribe({ subscriptionId: "probe" });
	assert.deepEqual(h.calls.unsubscribe, [{ subscriptionId: "probe" }]);
});

await test("getContext missing, denied, malformed, and no bridge fail safely", async () => {
	for (const options of [
		{ patch: (api) => { delete api.getContext; } },
		{ getContext: () => { throw error("PERMISSION_DENIED"); } },
		{ context: "not-a-context" }, { noBridge: true },
	]) {
		const h = harness(options);
		assert.equal((await h.SDK.getContextSafe()).ok, false);
	}
});

await test("default scope is exclusively context.narrator.id and four full topics", async () => {
	const h = await harness().start();
	assert.equal(h.calls.subscribe.length, 1);
	assert.deepEqual(h.calls.subscribe[0], {
		topics: ["narrafork.narrator.lifecycle", "narrafork.narrator.tool.changed", "narrafork.narrator.attention", "narrafork.narrator.permission.changed"],
		mode: "live", scope: { narratorId: "n-a" }, filter: { narratorIds: ["n-a"] },
		delivery: { transport: "poll", queueEvents: 200, queueBytes: 131072, maxRatePerSecond: 50 },
	});
	assert.equal(h.state().scope[0].source, "context");
	assert.equal(h.state().capability, "available");
	assert.equal(h.state().tasks[0].reliable, false, "live subscriptions do not imply a snapshot");
	assert.ok(h.state().limitations.answer.includes("不能可靠"));
	assert.ok(h.state().limitations.turnCost.includes("未公开"));
});

await test("absent context narrator never falls back to route/global/list", async () => {
	const h = await harness({ context: { route: { narratorId: "untrusted" }, narratorId: "untrusted" } }).start();
	assert.equal(h.state().capability, "unbound");
	assert.equal(h.calls.subscribe.length, 0);
	assert.deepEqual(h.state().scope, []);
});

await test("missing or partial events interface degrades only this module", async () => {
	for (const key of ["subscribe", "poll", "unsubscribe"]) {
		const h = await harness({ patch: (api) => { delete api.events[key]; } }).start();
		assert.equal(h.SDK.events(), undefined);
		assert.equal(h.state().capability, "unavailable");
		assert.equal(h.calls.subscribe.length, 0);
		await h.clock.advance(10000);
		assert.equal(h.calls.contexts, 0);
	}
});

await test("explicit associations replace auto scope and remain view-local", async () => {
	const h = await harness().start();
	assert.equal(h.task.setAssociations([{ narratorId: "n-b", alias: "构建" }, { narratorId: "n-c", alias: "测试" }, { narratorId: "n-d", alias: "检查" }]).ok, true);
	await flush();
	assert.deepEqual(h.state().scope.map((item) => item.narratorId), ["n-b", "n-c", "n-d"]);
	assert.equal(h.calls.unsubscribe.length, 1);
	for (const input of h.calls.subscribe.slice(1)) assert.deepEqual(input.filter.narratorIds, [input.scope.narratorId]);
	const fresh = await harness({ context: {} }).start();
	assert.equal(fresh.calls.subscribe.length, 0, "a new view must not inherit bindings");
});

await test("invalid, duplicate, and over-limit associations are rejected atomically", async () => {
	const h = await harness().start();
	for (const value of [null, [{ narratorId: "" }], [{ narratorId: "n-a" }, { narratorId: "n-a" }], [1, 2, 3, 4].map((n) => ({ narratorId: `n-${n}` }))]) {
		assert.equal(h.task.setAssociations(value).ok, false);
	}
	assert.equal(h.calls.subscribe.length, 1);
	assert.deepEqual(h.state().scope.map((item) => item.narratorId), ["n-a"]);
});

await test("pending permission and matching attention produce one notice", async () => {
	const h = await harness().start();
	await h.poll([permission(), attention("waiting_permission"), permission()]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].kind, "permission");
	assert.equal(h.notices[0].sticky, true);
	assert.equal(h.state().tasks[0].waitingPermission, true);
});

await test("attention resolved clears pending and replay of closed request stays closed", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	await h.poll([attention("waiting_permission", "resolved"), attention("waiting_permission", "resolved"), permission()]);
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.clears, [h.notices[0].id]);
	assert.equal(h.state().tasks[0].waitingPermission, false);
});

await test("dismissed request never reopens on duplicates or reconnection", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	h.task.dismiss(h.notices[0].id);
	await h.poll([permission(), attention("waiting_permission")]);
	await h.task.retry();
	await h.poll([permission()]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.state().tasks[0].waitingPermission, true);
	await h.poll([permission("n-a", "new-request")]);
	assert.equal(h.notices.length, 2, "a different request remains actionable");
});

await test("attention-before-request adopts same notice including user dismissal", async () => {
	const h = await harness().start();
	await h.poll([attention("waiting_permission")]);
	h.task.dismiss(h.notices[0].id);
	await h.poll([permission()]);
	await h.task.retry();
	await h.poll([permission()]);
	assert.equal(h.notices.length, 1);
});

await test("unreliable waiting/question signals never assert waiting for an answer", async () => {
	const h = await harness().start();
	await h.poll([
		lifecycle("waiting"), tool("running", "question-1", "n-a", { toolName: "AskUserQuestion" }),
		attention("waiting_answer"), event("permission.changed", { narratorId: "n-a", requestId: "req-1", state: "approved" }),
	]);
	assert.equal(h.notices.length, 0);
	assert.equal(h.state().tasks[0].waitingPermission, false);
	assert.equal(h.state().tasks[0].status, "waiting");
	assert.equal(Object.hasOwn(h.state().tasks[0], "waitingAnswer"), false);
});

await test("done requires semantic attention and suppresses active background work", async () => {
	const h = await harness().start();
	await h.poll([lifecycle("idle"), attention("done", "raised", "n-a", { backgroundWorkActive: true })]);
	assert.equal(h.notices.length, 0);
	await h.poll([attention("done"), attention("done")]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].kind, "done");
	await h.poll([attention("done", "resolved")]);
	assert.equal(h.clears.length, 1);
});

await test("lifecycle error and semantic error are de-duplicated until normal progress", async () => {
	const h = await harness().start();
	await h.poll([event("lifecycle", { narratorId: "n-a", changeKind: "error", status: "error" }), attention("error")]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].kind, "error");
	await h.poll([lifecycle("working")]);
	assert.equal(h.clears.length, 1);
	await h.poll([attention("error")]);
	assert.equal(h.notices.length, 2);
});

await test("tool metadata failure notices never read tool input/output or error body", async () => {
	const h = await harness().start();
	const failedTool = tool("fail");
	for (const key of ["input", "output", "errorMessage", "detail"]) Object.defineProperty(failedTool.data, key, { get() { throw new Error(`sensitive ${key} read`); } });
	await h.poll([failedTool]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].kind, "error");
	await h.poll([tool("success", "unrelated-tool")]);
	assert.equal(h.clears.length, 0);
	await h.poll([tool("success")]);
	assert.equal(h.clears.length, 1);
});

await test("foreign narrator and conflicting resource identities cannot cross scope", async () => {
	const h = await harness().start();
	const resourceConflict = permission(); resourceConflict.resource.narratorId = "n-b";
	const idConflict = permission(); idConflict.resource.id = "n-b";
	await h.poll([permission("n-b"), resourceConflict, idConflict, permission()]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].narratorId, "n-a");
});

await test("normal progress clears only that narrator's notices", async () => {
	const h = harness();
	h.task.setAssociations([{ narratorId: "n-a", alias: "A" }, { narratorId: "n-b", alias: "B" }]);
	await h.start();
	h.enqueue([permission()]); h.enqueue([permission("n-b")], "n-b");
	await h.clock.advance(1000);
	assert.equal(h.notices.length, 2);
	await h.poll([lifecycle("working")]);
	assert.deepEqual(h.state().tasks.map((entry) => entry.waitingPermission), [false, true]);
	assert.deepEqual(h.clears, [h.notices.find((entry) => entry.narratorId === "n-a").id]);
});

await test("eventId and deliverySeq independently de-duplicate real envelopes", async () => {
	const h = await harness().start();
	const first = permission("n-a", "one", { deliverySeq: 10 });
	const sameId = { ...first, deliverySeq: 11 };
	const oldSeq = permission("n-a", "two", { deliverySeq: 11 });
	await h.poll([first, sameId, oldSeq]);
	assert.equal(h.notices.length, 1);
	await h.poll([permission("n-a", "two", { deliverySeq: 12 })]);
	assert.equal(h.notices.length, 2);
});

await test("malformed envelopes and shorthand topics do not create notices", async () => {
	const h = await harness().start();
	await h.poll([
		{ ...permission(), schemaVersion: 2 }, { ...permission(), schema: "wrong" },
		{ ...permission(), eventId: "" }, { ...permission(), occurredAt: "yesterday" },
		{ ...permission(), deliverySeq: -1 }, { ...permission(), topic: "permission.changed" },
	]);
	assert.equal(h.notices.length, 0);
});

await test("canonical poll result uses exact subscription envelope", async () => {
	const h = await harness().start();
	await h.poll({ subscriptionId: h.sub(), events: [permission()], hasMore: false, resyncRequired: false });
	assert.equal(h.notices.length, 1);
});

await test("canonical hasMore drains at most four pages per one-second tick", async () => {
	const h = await harness().start();
	for (let n = 0; n < 6; n += 1) h.enqueue({ subscriptionId: h.sub(), events: [], hasMore: n < 5 });
	await h.clock.advance(1000);
	assert.equal(h.calls.poll.length, 4);
	assert.ok(h.calls.poll.every((input) => input.limit === 50));
	await h.clock.advance(1000);
	assert.equal(h.calls.poll.length, 6);
});

await test("pinned host array response drains a full page without requiring hasMore", async () => {
	const h = await harness().start();
	h.enqueue(Array.from({ length: 50 }, () => lifecycle("working")));
	h.enqueue([permission()]);
	await h.clock.advance(1000);
	assert.equal(h.calls.poll.length, 2);
	assert.equal(h.notices.length, 1);
});

await test("overflow discards unsafe batch, clears waiting, and resubscribes", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	await h.poll([permission("n-a", "unsafe-new"), control("overflow", h.sub())]);
	assert.equal(h.state().tasks[0].waitingPermission, false);
	assert.equal(h.state().tasks[0].reliable, false);
	assert.equal(h.notices.length, 1);
	assert.equal(h.calls.unsubscribe.length, 1);
	await h.clock.advance(1000);
	assert.equal(h.calls.subscribe.length, 2);
});

await test("both resync control and canonical resyncRequired clear stale waiting", async () => {
	for (const form of ["event", "flag"]) {
		const h = await harness().start();
		await h.poll([permission()]);
		await h.poll(form === "event" ? [control("resync_required", h.sub())] : { subscriptionId: h.sub(), events: [], hasMore: false, resyncRequired: true });
		assert.equal(h.state().tasks[0].waitingPermission, false);
		assert.equal(h.state().error.code, "EVENT_RESYNC_REQUIRED");
	}
});

await test("disconnect immediately revokes waiting then reconnects", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	await h.poll(error("HOST_UNAVAILABLE"));
	assert.equal(h.state().tasks[0].waitingPermission, false);
	assert.equal(h.state().capability, "degraded");
	await h.clock.advance(1000);
	assert.equal(h.calls.subscribe.length, 2);
	assert.equal(h.state().tasks[0].status, "unknown");
});

await test("permission denial and method absence stop automatic retry", async () => {
	for (const [code, capability] of [["PERMISSION_DENIED", "denied"], ["METHOD_NOT_FOUND", "unavailable"]]) {
		const h = await harness({ subscribe() { throw error(code); } }).start();
		assert.equal(h.state().capability, capability);
		await h.clock.advance(10000);
		assert.equal(h.calls.subscribe.length, 1);
		assert.equal(h.notices.length, 0);
	}
});

await test("one denied scope does not stop another associated narrator", async () => {
	const h = harness({ subscribe(input, result) { if (input.scope.narratorId === "n-b") throw error("PERMISSION_DENIED"); return result; } });
	h.task.setAssociations([{ narratorId: "n-a" }, { narratorId: "n-b" }]);
	await h.start();
	assert.equal(h.state().capability, "degraded");
	await h.poll([permission()]);
	assert.equal(h.notices.length, 1);
	assert.equal(h.calls.subscribe.length, 2);
});

await test("poll timeout is bounded and its late result is ignored", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	const wait = deferred();
	h.enqueue(() => wait.promise);
	await h.clock.advance(1000);
	await h.clock.advance(5000);
	assert.equal(h.state().tasks[0].waitingPermission, false);
	assert.equal(h.state().error.code, "TIMEOUT");
	wait.resolve([permission("n-a", "late")]); await flush();
	assert.equal(h.notices.length, 1);
});

await test("silent host cancellation cannot leave permanent permission waiting", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	await h.clock.advance(30000);
	assert.equal(h.state().tasks[0].waitingPermission, false);
	assert.equal(h.state().error.code, "STALE_PERMISSION");
	await h.clock.advance(1000);
	assert.equal(h.calls.subscribe.length, 2);
});

await test("hidden view unsubscribes and clears state; visible view resubscribes", async () => {
	const h = await harness().start();
	await h.poll([permission()]);
	await h.visibility(true);
	assert.equal(h.state().capability, "hidden");
	assert.equal(h.state().tasks.length, 0);
	assert.equal(h.clears.length, 1);
	const count = h.calls.poll.length;
	await h.clock.advance(10000);
	assert.equal(h.calls.poll.length, count);
	await h.visibility(false);
	assert.equal(h.calls.subscribe.length, 2);
	assert.equal(h.state().tasks[0].waitingPermission, false);
});

await test("association removal cancels old in-flight result and does not auto-rebind", async () => {
	const h = await harness().start();
	const wait = deferred(); h.enqueue(() => wait.promise);
	await h.clock.advance(1000);
	h.task.setAssociations([]); await flush();
	wait.resolve([permission()]); await flush();
	assert.equal(h.state().capability, "unbound");
	assert.equal(h.notices.length, 0);
	await h.visibility(true); await h.visibility(false);
	assert.equal(h.calls.subscribe.length, 1);
});

await test("association replacement rejects late old-narrator events", async () => {
	const h = await harness().start();
	const wait = deferred(); h.enqueue(() => wait.promise);
	await h.clock.advance(1000);
	h.task.setAssociations([{ narratorId: "n-b", alias: "新任务" }]); await flush();
	wait.resolve([permission()]); await flush();
	await h.poll([permission("n-b")], "n-b");
	assert.deepEqual(h.notices.map((value) => value.narratorId), ["n-b"]);
});

await test("destroy releases a late subscription without invoking old callbacks", async () => {
	const wait = deferred();
	const h = harness({ subscribe(_input, result) { wait.result = result; return wait.promise; } });
	const start = h.task.start(); await flush();
	const before = h.states.length;
	h.destroy(); wait.resolve(wait.result); await start; await flush();
	assert.equal(h.states.length, before);
	assert.equal(h.calls.unsubscribe.length, 1);
	assert.equal(h.notices.length, 0);
	assert.equal(h.clock.jobs.size, 0);
	assert.equal(h.listeners.get("visibilitychange").size, 0);
});

await test("destroy cancels in-flight poll and prevents all later notices", async () => {
	const h = await harness().start();
	const wait = deferred(); h.enqueue(() => wait.promise); await h.clock.advance(1000);
	h.destroy(); const before = h.states.length;
	wait.resolve([permission()]); await flush(); await h.clock.advance(10000);
	assert.equal(h.notices.length, 0);
	assert.equal(h.states.length, before);
	assert.equal(h.clock.jobs.size, 0);
});

await test("disabled config avoids context/subscriptions and toggles cleanly", async () => {
	const h = await harness({ config: { enabled: false } }).start();
	assert.equal(h.state().capability, "disabled");
	assert.equal(h.calls.contexts, 0);
	await h.task.configure({ enabled: true });
	await h.poll([permission()]);
	await h.task.configure({ enabled: false });
	assert.equal(h.state().tasks.length, 0);
	assert.equal(h.clears.length, 1);
	await h.task.configure({ enabled: true });
	assert.equal(h.calls.subscribe.length, 2);
});

await test("context timeout does not block explicitly supplied known narrator", async () => {
	const wait = deferred();
	const h = harness({ getContext: () => wait.promise });
	const start = h.task.start(); await flush(); await h.clock.advance(5000); await start;
	assert.equal(h.calls.subscribe.length, 0);
	assert.equal(h.state().error.code, "TIMEOUT");
	h.task.setAssociations([{ narratorId: "n-b" }]); await flush();
	assert.equal(h.calls.subscribe.length, 1);
	wait.resolve({ narrator: { id: "n-a" } }); await flush();
	assert.equal(h.state().scope[0].narratorId, "n-b");
});

await test("foreign subscription envelope and oversized pages fail closed", async () => {
	for (const oversized of [false, true]) {
		const h = await harness().start();
		await h.poll([permission()]);
		await h.poll(oversized ? Array.from({ length: 51 }, () => permission()) : { subscriptionId: "foreign", events: [permission()], hasMore: false });
		assert.equal(h.state().tasks[0].waitingPermission, false);
		assert.equal(h.state().error.code, "INVALID_EVENT_RESPONSE");
		assert.equal(h.notices.length, 1);
	}
});

await test("multiple pending requests clear on narrator-level resolved event", async () => {
	const h = await harness().start();
	await h.poll([permission("n-a", "one"), permission("n-a", "two")]);
	assert.equal(h.notices.length, 2);
	await h.poll([attention("waiting_permission", "resolved")]);
	assert.equal(h.clears.length, 2);
	assert.equal(h.state().tasks[0].waitingPermission, false);
});

await test("presentation callback failures cannot interrupt other task polling", async () => {
	const h = await harness({ onNotice() { throw new Error("presentation failed"); }, onState() { throw new Error("state view failed"); }, onClear() { throw new Error("clear failed"); } }).start();
	await h.poll([permission()]);
	await h.poll([attention("waiting_permission", "resolved"), attention("done")]);
	assert.equal(h.state().capability, "available");
	assert.equal(h.notices.length, 2);
	assert.equal(h.clears.length, 1);
});

await test("late timed-out subscribe is released and retry obtains a fresh subscription", async () => {
	const wait = deferred(); let attempts = 0;
	const h = harness({ subscribe(_input, result) { attempts += 1; if (attempts === 1) { wait.result = result; return wait.promise; } return result; } });
	const start = h.task.start(); await flush(); await h.clock.advance(5000); await start;
	assert.equal(h.state().error.code, "TIMEOUT");
	wait.resolve(wait.result); await flush();
	assert.deepEqual(h.calls.unsubscribe, [{ subscriptionId: "sub_1" }]);
	await h.clock.advance(1000);
	assert.equal(h.state().capability, "available");
	assert.equal(h.calls.subscribe.length, 2);
});

await test("transient subscribe errors retry with bounded exponential backoff", async () => {
	let attempts = 0;
	const h = await harness({ subscribe(_input, result) { attempts += 1; if (attempts < 3) throw error("HOST_UNAVAILABLE"); return result; } }).start();
	await h.clock.advance(1000); assert.equal(attempts, 2);
	await h.clock.advance(1000); assert.equal(attempts, 2);
	await h.clock.advance(1000); assert.equal(attempts, 3);
	assert.equal(h.state().capability, "available");
});

await test("reentrant onState destruction cannot schedule a timer or start context RPC", async () => {
	for (const capability of ["checking", "available"]) {
		let h;
		h = harness({ onState(value) { if (value.capability === capability) h.task.destroy(); } });
		await h.start();
		assert.equal(h.clock.jobs.size, 0);
		assert.equal(h.task.destroyed, true);
		if (capability === "checking") assert.equal(h.calls.contexts, 0);
	}
});

process.stdout.write(`\nTask event selftest: ${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
