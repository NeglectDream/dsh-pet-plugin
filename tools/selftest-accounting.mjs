/** Offline deterministic regression: no host installation, network, or dependencies. */
import assert from "node:assert/strict";
import { createAccounting, toAtoms, fromAtoms, accountIdentity, validateLedger, validateLedgerGet,
	validateCorrection, validateNoticeInput, LEDGER_KEY, MAX_DAYS, MAX_AUDIT } from "../server/accounting.js";
import { sanitizeConfig, mergeConfig, DEFAULT_CONFIG, CONFIG_VERSION } from "../server/config.js";
import { balanceEventIndex, refreshBalance, activeAccounts, BALANCE_KEY } from "../server/balance/index.js";
import { measureAmount, finiteNumber } from "../server/balance/amounts.js";
import { num, looseNum, customProvider, readPath, MAX_RESPONSE_BYTES } from "../server/balance/providers.js";

let passed = 0;
const failures = [];
async function test(label, work) {
	try { await work(); passed += 1; process.stdout.write(`PASS ${label}\n`); }
	catch (error) { failures.push(label); process.stderr.write(`FAIL ${label}: ${error.stack}\n`); }
}
const BASE = Date.parse("2026-11-10T04:00:00.000Z");
const configOf = (patch = {}) => sanitizeConfig(mergeConfig(mergeConfig(DEFAULT_CONFIG, { accounting: { timeZone: "Asia/Shanghai" } }), patch)).config;
const raw = (amount, time = BASE, patch = {}) => ({ source: "manual", providerId: "test-provider", keyFingerprint: "safe-backend-fingerprint",
	currency: "USD", shape: "money", scope: "money", slot: 0, label: "测试账户", remaining: amount, total: "20", used: null,
	unlimited: false, sampledAt: new Date(time).toISOString(), stale: false, ok: true, remainingPercent: Number(amount) / 20 * 100, ...patch });

function harness(patch = {}, startClock = BASE) {
	const storage = new Map();
	const secrets = new Map();
	let clock = startClock, failedWrites = 0, writes = 0;
	const callHost = async (method, params) => {
		if (method === "secrets.get") return { value: secrets.get(params.key) ?? null };
		assert.equal(params.scope.type, "global");
		if (method === "storage.get") return storage.has(params.key) ? { value: structuredClone(storage.get(params.key)) } : null;
		if (method === "storage.set") {
			if (failedWrites > 0) { failedWrites -= 1; throw new Error("injected storage failure"); }
			storage.set(params.key, structuredClone(params.value)); writes += 1; return { stored: true };
		}
		throw new Error(`unexpected method ${method}`);
	};
	const config = configOf(patch);
	const service = createAccounting({ callHost, now: () => clock });
	return { storage, secrets, config, service, callHost,
		get now() { return clock; }, get writes() { return writes; },
		advance(ms = 1000) { clock += ms; }, setTime(time) { clock = time; }, fail(count = 1) { failedWrites = count; },
		sample(amount, extra = {}) { return service.ingest([raw(amount, clock, extra)], config); },
		async account(options = {}) { return (await service.read(config, options)).accounts[0]; },
		cloneService() { return createAccounting({ callHost, now: () => clock }); },
	};
}
const errorKind = (kind) => (error) => error?.kind === kind;
const correctionFor = (ledger, patch = {}) => ({ accountId: ledger.accounts[0].accountId, revision: ledger.revision, confirmed: true,
	action: "set", confirmedTopUp: "5", nonUsageDebit: "1", note: "已核对真实到账与非调用扣减", ...patch });

await test("八位定点：真实零与负数", () => { assert.equal(toAtoms(0), 0); assert.equal(toAtoms("-1.25"), -125000000); assert.equal(fromAtoms(-1), "-0.00000001"); });
await test("一次舍入：不把0.00000000499双舍入为1", () => { assert.equal(toAtoms("0.00000000499"), 0); assert.equal(toAtoms("0.000000005"), 1); assert.equal(toAtoms("-0.000000005"), -1); });
await test("科学计数与小数尾零", () => { assert.equal(toAtoms("1e-8"), 1); assert.equal(toAtoms("1.234567895e0"), 123456790); assert.equal(toAtoms("1e-400"), 0); assert.equal(fromAtoms(toAtoms("1.2")), "1.20000000"); });
await test("安全整数边界精确接受", () => { assert.equal(toAtoms("90071992.54740991"), Number.MAX_SAFE_INTEGER); assert.equal(toAtoms("-90071992.54740991"), -Number.MAX_SAFE_INTEGER); });
await test("安全整数溢出拒绝", () => { assert.throws(() => toAtoms("90071992.54740992"), errorKind("AMOUNT_OVERFLOW")); assert.throws(() => toAtoms("1e1000"), errorKind("AMOUNT_OVERFLOW")); });
await test("null布尔空白NaN不伪装零", () => { for (const v of [null, undefined, true, false, "", "  ", NaN, Infinity, {}, "NaN", "0x10"]) assert.throws(() => toAtoms(v)); });
await test("数值解析拒绝null与布尔", () => { assert.throws(() => num(null, "balance")); assert.throws(() => num(true, "balance")); assert.equal(looseNum(false), undefined); assert.equal(num("0", "balance"), 0); assert.equal(finiteNumber("1.5"), 1.5); assert.equal(finiteNumber("1e"), null); });
await test("未知金额不产生已用100%", () => { const a = measureAmount({ remaining: null, total: null }); assert.equal(a.percent, null); assert.equal(a.remainingPercent, null); });
await test("真实0/负余额与无限额分别表达", () => { assert.equal(measureAmount({ remaining: 0, total: 10 }).percent, 100); assert.equal(measureAmount({ remaining: -1, total: 10 }).remainingPercent, -10); const u = measureAmount({ remaining: null, unlimited: true }); assert.equal(u.percent, 0); assert.equal(u.remainingPercent, null); });
await test("剩余与已用构成真实额度比例", () => { const a = measureAmount({ remaining: "2.5", used: "7.5" }); assert.equal(a.percent, 75); assert.equal(a.remainingPercent, 25); assert.equal(a.percentBasis, "quota"); });
await test("只有剩余时比例未知而不是零", () => { const a = measureAmount({ remaining: "5" }); assert.equal(a.percent, null); assert.equal(a.remainingPercent, null); assert.equal(a.percentBasis, "unknown"); });
await test("阈值全局统一", () => { assert.equal(balanceEventIndex(75, [10, 30, 50, 70, 100]), 4); assert.equal(balanceEventIndex(100), 5); assert.equal(balanceEventIndex(20), 1); assert.equal(balanceEventIndex(null), undefined); });

/* -- single custom API: request shape, parsing, safety --------------------- */

function stubFetch(handler) {
	return async (url, init) => handler(String(url), init);
}
function jsonResponse(body, status = 200, headers = {}) {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const customConfig = (patch = {}) => ({ url: "https://balance.test/ok", totalPath: "data.remaining", ...patch });

await test("自定义API固定GET+Bearer+redirect:error", async () => {
	let seen;
	const result = await customProvider.fetch({ key: "test-secret-key", custom: customConfig({ usedPath: "data.used" }),
		fetchImpl: stubFetch((url, init) => {
			seen = { url, method: init.method, auth: init.headers.Authorization, redirect: init.redirect, accept: init.headers.Accept };
			return jsonResponse({ data: { remaining: "10", used: "30" } });
		}) });
	assert.equal(seen.method, "GET");
	assert.equal(seen.auth, "Bearer test-secret-key");
	assert.equal(seen.redirect, "error");
	assert.equal(seen.accept, "application/json");
	assert.deepEqual({ remaining: result.remaining, used: result.used, currency: result.currency, shape: result.shape }, { remaining: 10, used: 30, currency: "POINTS", shape: "points" });
});
await test("自定义API默认积分且不猜货币", async () => {
	const result = await customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse({ data: { remaining: 0 } })) });
	assert.equal(result.currency, "POINTS"); assert.equal(result.shape, "points"); assert.equal(result.remaining, 0); assert.equal(result.used, null);
	const money = await customProvider.fetch({ key: "k", custom: customConfig({ currency: "USD" }), fetchImpl: stubFetch(() => jsonResponse({ data: { remaining: -2 } })) });
	assert.equal(money.shape, "money"); assert.equal(money.currency, "USD"); assert.equal(money.remaining, -2);
});
await test("字段缺失/非法一律 shape_mismatch，不生成0", async () => {
	const cases = [{ data: {} }, { data: { remaining: null } }, { data: { remaining: true } }, { data: { remaining: "abc" } }, { data: { remaining: {} } }];
	for (const body of cases) {
		await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse(body)) }), errorKind("shape_mismatch"));
	}
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig({ totalPath: "" }), fetchImpl: stubFetch(() => jsonResponse({ data: { remaining: 1 } })) }), errorKind("shape_mismatch"));
});
await test("usedPath 缺失或非法不是零", async () => {
	const missing = await customProvider.fetch({ key: "k", custom: customConfig({ usedPath: "data.used" }), fetchImpl: stubFetch(() => jsonResponse({ data: { remaining: 10 } })) });
	assert.equal(missing.used, null);
	const garbage = await customProvider.fetch({ key: "k", custom: customConfig({ usedPath: "data.used" }), fetchImpl: stubFetch(() => jsonResponse({ data: { remaining: 10, used: null } })) });
	assert.equal(garbage.used, null);
});
await test("仅HTTPS且无内嵌凭据", async () => {
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig({ url: "http://balance.test/ok" }), fetchImpl: stubFetch(() => jsonResponse({})) }), errorKind("not_configured"));
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig({ url: "" }), fetchImpl: stubFetch(() => jsonResponse({})) }), errorKind("not_configured"));
});
await test("401/403鉴权失败与其它HTTP错误分类", async () => {
	for (const status of [401, 403]) {
		await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse({}, status)) }), errorKind("auth_failed"));
	}
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse({}, 500)) }), errorKind("http"));
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse({}, 302, { location: "https://elsewhere.test" })) }), errorKind("redirect"));
});
await test("超时与网络错误分类且信息不含URL或密钥", async () => {
	const secret = "super-secret-canary-key";
	const timeout = customProvider.fetch({ key: secret, custom: customConfig({ url: "https://secret-endpoint-canary.test/ok" }), deadlineMs: 30,
		fetchImpl: stubFetch((url, init) => new Promise((resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
		})) });
	await assert.rejects(timeout, (error) => {
		assert.equal(error.kind, "timeout");
		assert.ok(!error.message.includes("secret-endpoint-canary"));
		assert.ok(!error.message.includes(secret));
		return true;
	});
	await assert.rejects(customProvider.fetch({ key: secret, custom: customConfig(), fetchImpl: stubFetch(() => { throw new TypeError("fetch failed: secret-endpoint-canary.test"); }) }), (error) => {
		assert.equal(error.kind, "network");
		assert.ok(!error.message.includes("canary"));
		return true;
	});
});
await test("响应超过1MiB被拒绝", async () => {
	const big = JSON.stringify({ data: { remaining: 1, padding: "x".repeat(MAX_RESPONSE_BYTES + 1024) } });
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse(big)) }), errorKind("response_too_large"));
});
await test("非法JSON是shape错误", async () => {
	await assert.rejects(customProvider.fetch({ key: "k", custom: customConfig(), fetchImpl: stubFetch(() => jsonResponse("not json at all")) }), errorKind("shape_mismatch"));
});
await test("dot path 逐段取值为纯数据", () => {
	assert.equal(readPath({ a: { b: [{ c: 3 }] } }, "a.b.0.c"), 3);
	assert.equal(readPath({ a: null }, "a.b"), undefined);
	assert.equal(readPath({}, ""), undefined);
});

/* -- ledger ---------------------------------------------------------------- */

await test("10→8→13→12累计下降3上涨5", async () => {
	const h = harness(); await h.sample("10"); h.advance(); await h.sample("8"); h.advance(); await h.sample("13"); h.advance(); await h.sample("12");
	const a = await h.account(); assert.equal(a.observedSpend, "3.00000000"); assert.equal(a.observedRise, "5.00000000"); assert.equal(a.today.spend, "3.00000000"); assert.equal(a.estimatedSpend, "3.00000000"); assert.equal(a.correctedSpend, null);
});
await test("重复样本不写入也不记账", async () => { const h = harness(); await h.sample("10"); const before = h.writes; await h.sample("10"); assert.equal(h.writes, before); assert.equal((await h.account()).observedSpend, "0.00000000"); });
await test("相同时间不同金额不重写基线", async () => { const h = harness(); await h.sample("10"); await h.sample("8"); assert.equal((await h.account()).balance, "10.00000000"); });
await test("乱序样本不记账也不覆盖新余额", async () => { const h = harness(); await h.sample("10"); h.advance(); await h.sample("8"); await h.service.ingest([raw("0", BASE)], h.config); assert.equal((await h.account()).balance, "8.00000000"); assert.equal((await h.account()).observedSpend, "2.00000000"); });
await test("失败保留原值并标旧，不产生消费", async () => { const h = harness(); await h.sample("10"); h.advance(); await h.sample("0", { stale: true, ok: false }); const a = await h.account(); assert.equal(a.balance, "10.00000000"); assert.equal(a.observedSpend, "0.00000000"); assert.equal(a.stale, true); });
await test("失败恢复后只算成功基线的变化", async () => { const h = harness(); await h.sample("10"); h.advance(); await h.sample("0", { stale: true }); h.advance(); await h.sample("8"); assert.equal((await h.account()).observedSpend, "2.00000000"); });
await test("null样本不是余额零", async () => { const h = harness(); await h.sample("10"); h.advance(); await h.sample(null, { remainingPercent: null }); assert.equal((await h.account()).balance, "10.00000000"); assert.equal((await h.account()).stale, true); });
await test("未知/未来时间不建立账本基线", async () => { const h = harness(); await h.sample("10", { sampledAt: null }); assert.equal((await h.account()).balance, null); await h.sample("0", { sampledAt: new Date(BASE + 120000).toISOString() }); assert.equal((await h.account()).balance, null); });
await test("跨日变化不强分配到今日", async () => { const h = harness(); h.setTime(Date.parse("2026-11-10T15:59:00Z")); await h.sample("10"); h.advance(120000); await h.sample("8"); const a = await h.account(); assert.equal(a.observedSpend, "2.00000000"); assert.equal(a.today.spend, "0.00000000"); assert.equal(a.unallocatedSpend, "2.00000000"); assert.ok(a.incompleteReasons.includes("跨日变化未分配到今日")); });
await test("长采样缺口保留总变化但不记到今日", async () => { const h = harness({ accounting: { maxGapMinutes: 1 } }); await h.sample("10"); h.advance(120000); await h.sample("8"); const a = await h.account(); assert.equal(a.today.spend, "0.00000000"); assert.equal(a.unallocatedSpend, "2.00000000"); });
await test("31日摘要有界且总额仍保留", async () => {
	const h = harness(); let balance = 100;
	for (let i = 0; i < 40; i += 1) { h.setTime(BASE + i * 86400000); await h.sample(String(balance)); h.advance(); balance -= 1; await h.sample(String(balance)); }
	const a = await h.account(); assert.equal(a.days.length, MAX_DAYS); assert.equal(a.observedSpend, "40.00000000"); assert.ok(validateLedger(h.storage.get(LEDGER_KEY)));
});
await test("provider/指纹/币种/时区完整隔离", async () => {
	const h = harness(); await h.sample("10"); await h.sample("8", { source: "host" }); await h.sample("8", { providerId: "other" }); await h.sample("8", { keyFingerprint: "rotated" }); await h.sample("8", { currency: "CNY" });
	await h.service.ingest([raw("8")], configOf({ accounting: { timeZone: "UTC" } }));
	const accounts = (await h.service.read(h.config)).accounts; assert.equal(accounts.length, 6); assert.equal(new Set(accounts.map((a) => a.accountId)).size, 6); assert.ok(accounts.every((a) => a.observedSpend === "0.00000000"));
});
await test("points不是货币消费", async () => { const h = harness(); await h.sample("10", { shape: "points" }); h.advance(); await h.sample("0", { shape: "points" }); const a = await h.account(); assert.equal(a.eligible, false); assert.equal(a.estimatedSpend, null); assert.equal(a.observedSpend, "0.00000000"); });
await test("缺乏凭据身份的账户不做消费", async () => { const h = harness(); await h.sample("10", { accountingEligible: false }); h.advance(); await h.sample("8", { accountingEligible: false }); assert.equal((await h.account()).eligible, false); assert.equal((await h.account()).observedSpend, "0.00000000"); });
await test("旧host ledger的raw providerId只留私有存储", async () => {
	const host = harness(); await host.sample("10", { source: "host", providerId: "raw-host-key-canary" });
	const publicHost = await host.service.read(host.config, { audit: true });
	assert.equal(Object.hasOwn(publicHost.accounts[0], "providerId"), false);
	assert.equal(host.storage.get(LEDGER_KEY).accounts[0].providerId, "raw-host-key-canary");
	const manual = harness(); await manual.sample("10");
	assert.equal((await manual.service.read(manual.config)).accounts[0].providerId, "test-provider");
});
await test("累计溢出整笔拒绝且原记录保留", async () => { const h = harness(); await h.sample("90071992.54740991"); const before = structuredClone(h.storage.get(LEDGER_KEY)); h.advance(); await assert.rejects(h.sample("-90071992.54740991"), errorKind("AMOUNT_OVERFLOW")); assert.deepEqual(h.storage.get(LEDGER_KEY), before); });
await test("首次持久化失败不会产生假成功", async () => { const h = harness(); h.fail(); await assert.rejects(h.sample("10")); assert.equal(h.storage.has(LEDGER_KEY), false); await h.sample("10"); assert.equal((await h.account()).balance, "10.00000000"); });
await test("后续写失败回滚并允许正确重试", async () => { const h = harness(); await h.sample("10"); const before = structuredClone(h.storage.get(LEDGER_KEY)); h.advance(); h.fail(); await assert.rejects(h.sample("8")); assert.deepEqual(h.storage.get(LEDGER_KEY), before); await h.sample("8"); assert.equal((await h.account()).observedSpend, "2.00000000"); });
await test("损坏存储不覆盖且所有写路径停止", async () => { const h = harness(); const bad = { schemaVersion: 999, important: "retain" }; h.storage.set(LEDGER_KEY, bad); assert.equal((await h.service.read(h.config)).status, "corrupt"); await assert.rejects(h.sample("1"), errorKind("LEDGER_CORRUPT")); await assert.rejects(h.service.fingerprint("secret"), errorKind("LEDGER_CORRUPT")); await assert.rejects(h.service.notices({ action: "claim", consumerId: "a" }), errorKind("LEDGER_CORRUPT")); assert.deepEqual(h.storage.get(LEDGER_KEY), bad); });
await test("存储null也是损坏而非新建", async () => { const h = harness(); h.storage.set(LEDGER_KEY, null); await assert.rejects(h.sample("1"), errorKind("LEDGER_CORRUPT")); assert.equal(h.storage.get(LEDGER_KEY), null); });
await test("结构校验发现损坏定点值与重复日期", async () => { const h = harness(); await h.sample("10"); const bad = structuredClone(h.storage.get(LEDGER_KEY)); bad.accounts[0].balance = 0.1; assert.equal(validateLedger(bad), false); bad.accounts[0].balance = 1; bad.accounts[0].days = [{ date: "2026-11-10", spend: 0, rise: 0 }, { date: "2026-11-10", spend: 0, rise: 0 }]; assert.equal(validateLedger(bad), false); });
await test("后端密钥指纹有盐持久稳定且不回传", async () => { const h = harness(); const fp = await h.service.fingerprint("secret-value"); assert.equal(await h.cloneService().fingerprint("secret-value"), fp); assert.notEqual(await h.service.fingerprint("different"), fp); const other = harness(); assert.notEqual(await other.service.fingerprint("secret-value"), fp); await h.sample("1"); const publicText = JSON.stringify(await h.service.read(h.config)); assert.ok(!publicText.includes("salt") && !publicText.includes("secret-value") && !publicText.includes("keyFingerprint")); });
await test("多模块实例并发事务不会丢样本或重复累计", async () => { const h = harness(); await h.sample("10"); h.advance(); const other = h.cloneService(); await Promise.all([h.sample("8"), other.ingest([raw("8", h.now)], h.config)]); assert.equal((await h.account()).observedSpend, "2.00000000"); });
await test("账户上限时先驱逐旧数据而不丢当前余额", async () => {
	const h = harness();
	for (let index = 0; index < 32; index += 1) await h.sample("5", { providerId: `old-${index}`, stale: true });
	h.advance();
	await h.sample("7", { providerId: "current" });
	const ledger = h.storage.get(LEDGER_KEY); assert.equal(ledger.accounts.length, 32); assert.ok(ledger.accounts.some((account) => account.providerId === "current")); assert.ok(validateLedger(ledger));
});

await test("累计到账与非调用扣减显式修正，不修改下降观察值", async () => { const h = harness(); await h.sample("10"); h.advance(); const ledger = await h.sample("8"); const result = await h.service.correct(correctionFor(ledger), h.config); const a = result.ledger.accounts[0]; assert.equal(a.correctedSpend, "6.00000000"); assert.equal(a.observedSpend, "2.00000000"); assert.equal(a.today.spend, "2.00000000"); assert.equal(a.audit[0].action, "set"); });
await test("负修正净额保留以暴露校正不足", async () => { const h = harness(); await h.sample("10"); h.advance(); const ledger = await h.sample("13"); const result = await h.service.correct(correctionFor(ledger, { confirmedTopUp: "0", nonUsageDebit: "0" }), h.config); assert.equal(result.ledger.accounts[0].correctedSpend, "-3.00000000"); });
await test("revision冲突拒绝，不静默覆盖", async () => { const h = harness(); const ledger = await h.sample("10"); h.advance(); await h.sample("8"); await assert.rejects(h.service.correct(correctionFor(ledger), h.config), errorKind("REVISION_CONFLICT")); });
await test("同revision并发校正仅一次成功", async () => { const h = harness(); const ledger = await h.sample("10"); const input = correctionFor(ledger); const results = await Promise.allSettled([h.service.correct(input, h.config), h.cloneService().correct(input, h.config)]); assert.equal(results.filter((x) => x.status === "fulfilled").length, 1); assert.equal(results.find((x) => x.status === "rejected").reason.kind, "REVISION_CONFLICT"); });
await test("撤销恢复before且追加可审计记录", async () => { const h = harness(); const ledger = await h.sample("10"); const corrected = await h.service.correct(correctionFor(ledger), h.config); const undone = await h.service.correct(correctionFor(corrected.ledger, { action: "undo", correctionId: corrected.correctionId, confirmedTopUp: undefined, nonUsageDebit: undefined }), h.config); const a = undone.ledger.accounts[0]; assert.equal(a.confirmedTopUp, null); assert.equal(a.nonUsageDebit, "0.00000000"); assert.equal(a.audit[0].undoneBy, undone.correctionId); assert.equal(a.audit[1].undoOf, corrected.correctionId); });
await test("只能撤销最新尚未撤销的修正", async () => { const h = harness(); const first = await h.service.correct(correctionFor(await h.sample("10")), h.config); const second = await h.service.correct(correctionFor(first.ledger, { confirmedTopUp: "6" }), h.config); await assert.rejects(h.service.correct(correctionFor(second.ledger, { action: "undo", correctionId: first.correctionId, confirmedTopUp: undefined, nonUsageDebit: undefined }), h.config), errorKind("UNDO_CONFLICT")); });
await test("修正持久化失败不改变revision或审计", async () => { const h = harness(); const ledger = await h.sample("10"); const before = structuredClone(h.storage.get(LEDGER_KEY)); h.fail(); await assert.rejects(h.service.correct(correctionFor(ledger), h.config)); assert.deepEqual(h.storage.get(LEDGER_KEY), before); });
await test("审计窗口有界且最新可撤销", async () => { const h = harness(); let ledger = await h.sample("10"); for (let n = 0; n < 25; n += 1) ledger = (await h.service.correct(correctionFor(ledger, { confirmedTopUp: String(n) }), h.config)).ledger; assert.equal(ledger.accounts[0].audit.length, MAX_AUDIT); assert.equal(ledger.accounts[0].audit.at(-1).undoneBy, null); });
await test("三个命令拒绝未知字段/错误类型/欠缺确认", () => {
	for (const v of [null, [], { days: "1" }, { days: 32 }, { audit: 1 }, { source: "host" }]) assert.throws(() => validateLedgerGet(v));
	for (const v of [{ action: "claim", consumerId: "a", limit: 0 }, { action: "claim", consumerId: "a", limit: 1.5 }, { action: "ack", consumerId: "a", id: "i" }, { action: "claim", consumerId: "a", extra: true }]) assert.throws(() => validateNoticeInput(v));
	assert.throws(() => validateCorrection({ accountId: accountIdentity(raw(1), "UTC"), revision: 0, confirmed: false, action: "set", confirmedTopUp: "0", nonUsageDebit: "0", note: "确认" }));
});

async function enabledHarness(kind = "balance", threshold = "8", extraRule = {}) {
	const h = harness(); const ledger = await h.sample("10"); h.config.alerts = { enabled: true, rules: [{ id: "rule", enabled: true,
		accountId: ledger.accounts[0].accountId, currency: "USD", kind, metric: "amount", threshold, hysteresis: "1", version: 1, ...extraRule }] };
	return h;
}
await test("预警默认关闭", async () => { const h = harness(); await h.sample("0"); assert.equal((await h.service.notices({ action: "claim", consumerId: "view" })).notices.length, 0); assert.equal(h.config.alerts.enabled, false); });
await test("真实零和负余额命中绝对阈值", async () => { const h = await enabledHarness("balance", "0"); h.advance(); await h.sample("0"); assert.equal((await h.service.notices({ action: "claim", consumerId: "a" })).notices.length, 1); const j = await enabledHarness("balance", "0"); j.advance(); await j.sample("-1"); assert.equal((await j.service.notices({ action: "claim", consumerId: "a" })).notices.length, 1); });
await test("币种与账户严格匹配，不做跨币种告警", async () => { const h = await enabledHarness(); h.config.alerts.rules[0].currency = "CNY"; h.advance(); await h.sample("0"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); h.config.alerts.rules[0].currency = "USD"; h.config.alerts.rules[0].accountId = accountIdentity(raw(1, BASE, { providerId: "other" }), "Asia/Shanghai"); h.advance(); await h.sample("0"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); });
await test("真实剩余百分比告警与参考值隔离", async () => { const h = await enabledHarness("balance", "50", { metric: "remainingPercent" }); h.advance(); await h.sample("8", { remainingPercent: null }); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); h.advance(); await h.sample("8", { remainingPercent: 40 }); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1); });
await test("迟滞恢复前不会重复提醒", async () => { const h = await enabledHarness(); for (const amount of ["8", "8.5", "7", "9", "8"]) { h.advance(); await h.sample(amount); } assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1); h.advance(); await h.sample("10"); h.advance(); await h.sample("8"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 2); });
await test("预算按当日消费闩锁一次，阈值版本变更可重评估", async () => { const h = await enabledHarness("budget", "2"); h.advance(); await h.sample("8"); h.advance(); await h.sample("7"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1); h.config.alerts.rules[0].version = 2; await h.service.evaluate(h.config); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 2); h.config.alerts.rules[0].threshold = "2.5"; await h.service.evaluate(h.config); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 3); });
await test("新统计日只用新日已观察消费并重新闩锁", async () => { const h = await enabledHarness("budget", "2"); h.advance(); await h.sample("8"); h.advance(86400000); await h.sample("7"); assert.equal((await h.account()).today.spend, "0.00000000"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); h.advance(); await h.sample("5"); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1); });
await test("缓存失败样本不触发预算或余额预警", async () => { const h = await enabledHarness(); h.advance(); await h.sample("0", { stale: true }); await h.service.evaluate(h.config); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); });
await test("读取轻量账本不会消费notices", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const before = structuredClone(h.storage.get(LEDGER_KEY)); const read = await h.service.read(h.config, { light: true }); assert.equal(Object.hasOwn(read.accounts[0], "days"), false); assert.equal(Object.hasOwn(read.accounts[0], "audit"), false); assert.deepEqual(h.storage.get(LEDGER_KEY), before); });
await test("多实例多视图claim仅一方领取且租约持久", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const claims = await Promise.all([h.service.notices({ action: "claim", consumerId: "a" }), h.cloneService().notices({ action: "claim", consumerId: "b" })]); assert.equal(claims[0].notices.length + claims[1].notices.length, 1); assert.equal((await h.cloneService().notices({ action: "claim", consumerId: "restart" })).notices.length, 0); });
await test("只有正确消费者和有效租约才能ack", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const n = (await h.service.notices({ action: "claim", consumerId: "a" })).notices[0]; assert.equal((await h.service.notices({ action: "ack", consumerId: "b", id: n.id, leaseToken: n.leaseToken })).acked, false); assert.equal((await h.service.notices({ action: "ack", consumerId: "a", id: n.id, leaseToken: "wrong" })).acked, false); assert.equal((await h.service.notices({ action: "ack", consumerId: "a", id: n.id, leaseToken: n.leaseToken })).acked, true); assert.equal((await h.service.notices({ action: "claim", consumerId: "b" })).notices.length, 0); });
await test("失联视图租约过期可重领，旧token失效", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const n = (await h.service.notices({ action: "claim", consumerId: "a" })).notices[0]; h.advance(61000); const retry = (await h.cloneService().notices({ action: "claim", consumerId: "b" })).notices[0]; assert.equal(retry.id, n.id); assert.notEqual(retry.leaseToken, n.leaseToken); assert.equal((await h.service.notices({ action: "ack", consumerId: "a", id: n.id, leaseToken: n.leaseToken })).acked, false); });
await test("过期提醒丢弃而不是补放", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); h.advance(7 * 3600000); assert.equal((await h.service.notices({ action: "claim", consumerId: "a" })).notices.length, 0); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 0); });
await test("claim写失败回滚租约，不伪装已领取", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const before = structuredClone(h.storage.get(LEDGER_KEY)); h.fail(); await assert.rejects(h.service.notices({ action: "claim", consumerId: "a" })); assert.deepEqual(h.storage.get(LEDGER_KEY), before); assert.equal((await h.service.notices({ action: "claim", consumerId: "b" })).notices.length, 1); });
await test("ack写失败保留租约和通知供重试", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); const n = (await h.service.notices({ action: "claim", consumerId: "a" })).notices[0]; const input = { action: "ack", consumerId: "a", id: n.id, leaseToken: n.leaseToken }; h.fail(); await assert.rejects(h.service.notices(input)); assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1); assert.equal((await h.service.notices(input)).acked, true); });
await test("通知队列最多64项", async () => { const h = await enabledHarness(); h.advance(); await h.sample("8"); for (let version = 2; version < 90; version += 1) { h.config.alerts.rules[0].version = version; await h.service.evaluate(h.config); } assert.equal(h.storage.get(LEDGER_KEY).notices.length, 64); assert.ok(h.storage.get(LEDGER_KEY).latches.length <= 128); });
await test("当前账户过滤隔离读取、校正与通知领取", async () => {
	const h = await enabledHarness(); h.advance(); await h.sample("8");
	const current = (await h.service.read(h.config)).accounts[0].accountId;
	const foreign = accountIdentity(raw(1, BASE, { providerId: "other-provider" }), "Asia/Shanghai");
	assert.equal((await h.service.read(h.config, { accountIds: [current] })).accounts.length, 1);
	assert.equal((await h.service.read(h.config, { accountIds: [] })).accounts.length, 0);
	assert.equal((await h.service.read(h.config, { accountIds: [foreign] })).accounts.length, 0);
	await assert.rejects(h.service.correct({ ...correctionFor({ accounts: [{ accountId: current }], revision: h.storage.get(LEDGER_KEY).revision }), accountId: current }, h.config, { accountIds: [foreign] }), errorKind("INVALID_PARAMS"));
	assert.equal((await h.service.notices({ action: "claim", consumerId: "view", accountIds: [foreign] })).notices.length, 0);
	assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1);
	assert.equal((await h.service.notices({ action: "claim", consumerId: "view", accountIds: [current] })).notices.length, 1);
});
await test("旧账户规则不参与预算评估", async () => {
	const h = await enabledHarness(); h.advance(); await h.sample("0");
	assert.equal(h.storage.get(LEDGER_KEY).notices.length, 1);
	const before = h.storage.get(LEDGER_KEY).notices.length;
	await h.service.evaluate(h.config, { accountIds: [] });
	assert.equal(h.storage.get(LEDGER_KEY).notices.length, before);
});

await test("配置升级到版本2并保留URL与路径", () => {
	const result = sanitizeConfig({ version: 1, narratorBalances: [{ narratorId: "n", providerId: `hp_${"a".repeat(64)}`, alias: "" }],
		balance: { source: "manual", providerId: "custom", custom: { url: "https://api.example.com/balance", totalPath: "data.remaining", usedPath: "data.used", method: "POST", headers: { "X-Old": "1" }, label: "旧标签" } } }).config;
	assert.equal(result.version, CONFIG_VERSION);
	assert.equal(result.balance.custom.url, "https://api.example.com/balance");
	assert.equal(result.balance.custom.totalPath, "data.remaining");
	assert.equal(result.balance.custom.usedPath, "data.used");
	assert.equal(result.balance.custom.currency, "POINTS");
	assert.equal(Object.hasOwn(result.balance, "source"), false);
	assert.equal(Object.hasOwn(result.balance, "providerId"), false);
	assert.equal(Object.hasOwn(result, "narratorBalances"), false);
	assert.equal(Object.hasOwn(result.balance.custom, "method"), false);
	assert.equal(Object.hasOwn(result.balance.custom, "headers"), false);
	const warnings = sanitizeConfig({ version: 1, balance: { source: "host", custom: { method: "POST", headers: { a: "b" } } } }).warnings.join("|");
	for (const fragment of ["版本 2", "来源选择", "请求方法", "请求头"]) assert.ok(warnings.includes(fragment), warnings);
});
await test("迁移警告在版本2后消失", () => { assert.equal(sanitizeConfig({ version: 2, balance: { refreshMinutes: 5 } }).warnings.length, 0); });
await test("http/凭据URL被拒绝，币种白名单", () => {
	const bad = sanitizeConfig({ balance: { custom: { url: "http://api.example.com/x", currency: "usd", totalPath: "a" } } });
	assert.equal(bad.config.balance.custom.url, ""); assert.ok(bad.warnings.some((text) => text.includes("HTTPS")));
	assert.equal(bad.config.balance.custom.currency, "USD");
	const creds = sanitizeConfig({ balance: { custom: { url: "https://user:pass@api.example.com/x" } } });
	assert.equal(creds.config.balance.custom.url, "");
	const points = sanitizeConfig({ balance: { custom: { currency: "CREDITS" } } });
	assert.equal(points.config.balance.custom.currency, "POINTS"); assert.ok(points.warnings.some((text) => text.includes("credits") || text.includes("CREDITS")));
});
await test("新旧配置兼容且新预警默认关闭", () => { const c = sanitizeConfig({ count: 2, sound: { enabled: false } }).config; assert.equal(c.count, 2); assert.equal(c.sound.enabled, false); assert.equal(c.bubbles.enabled, true); assert.equal(c.tasks.enabled, true); assert.equal(c.alerts.enabled, false); assert.deepEqual(c.balance, { refreshMinutes: 30, thresholds: [20, 40, 60, 80, 100], custom: { url: "", totalPath: "", usedPath: "", currency: "POINTS" } }); });
await test("气泡保持0与比例边界/纯文本覆盖", () => { const c = configOf({ bubbles: { scale: 10, durationMs: 0, noticeDurationMs: 0, clickMode: "home", overrides: [{ id: "safe", text: "<b>文字</b>", weight: 200 }, { id: "bad id", text: "ignore" }] } }); assert.equal(c.bubbles.scale, 1.4); assert.equal(c.bubbles.durationMs, 0); assert.equal(c.bubbles.noticeDurationMs, 0); assert.equal(c.bubbles.clickMode, "home"); assert.deepEqual(c.bubbles.overrides, [{ id: "safe", text: "文字", weight: 100 }]); });
await test("气泡覆盖120条上限与任务narrator丢弃", () => { const c = configOf({ bubbles: { overrides: Array.from({ length: 130 }, (_, i) => ({ id: `line-${i}`, text: "你好", weight: 1 })) }, tasks: { enabled: false, narratorId: "secret-context" } }); assert.equal(c.bubbles.overrides.length, 120); assert.deepEqual(c.tasks, { enabled: false }); });
await test("无效时区回退并记录警告", () => { const result = sanitizeConfig({ accounting: { timeZone: "not/a-zone" } }); assert.equal(result.config.accounting.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); assert.ok(result.warnings.length > 0); });
await test("预警规则精确账户/币种验证及8位金额", () => { const accountId = accountIdentity(raw(1), "Asia/Shanghai"); const result = sanitizeConfig({ alerts: { enabled: true, rules: [{ id: "good", accountId, currency: "USD", kind: "balance", threshold: "0.000000005" }, { id: "bad", accountId: "*", currency: "ANY", kind: "balance", threshold: 10 }] } }); assert.equal(result.config.alerts.rules.length, 1); assert.equal(result.config.alerts.rules[0].threshold, "0.00000001"); assert.ok(result.warnings.length > 0); });
await test("原型字段不通过配置合并", () => { const c = configOf(JSON.parse('{"__proto__":{"poisoned":true},"tasks":{"narratorId":"x"}}')); assert.equal({}.poisoned, undefined); assert.equal(c.tasks.narratorId, undefined); });

/* -- refresh: one endpoint, isolated context, stale retention -------------- */

function balanceHarness(custom = {}, patch = {}) {
	// The snapshot's sample time is the real clock, so the ledger clock has to be
	// "now" here; the fixed BASE belongs to the hand-sampled ledger tests.
	const h = harness(patch, Date.now());
	h.config = configOf({ ...patch, balance: { ...(patch.balance ?? {}), custom } });
	h.secrets.set("customApiKey", "selftest-key-one");
	return h;
}
const customOf = (h) => ({ callHost: h.callHost, config: h.config, accounting: h.service });
let fetchCalls = [];
function installFetch(handler) {
	const previous = globalThis.fetch;
	fetchCalls = [];
	globalThis.fetch = async (url, init) => { fetchCalls.push(String(url)); return handler(String(url), init); };
	return () => { globalThis.fetch = previous; };
}

await test("自定义API成功刷新、缓存与账本身份", async () => {
	const h = balanceHarness({ url: "https://balance.test/ok", totalPath: "data.remaining", currency: "USD" });
	let amount = 10;
	const restore = installFetch(() => jsonResponse({ data: { remaining: amount } }));
	try {
		const first = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(first.snapshot.ok, true);
		assert.equal(first.snapshot.accounts.length, 1);
		assert.equal(first.snapshot.accounts[0].remaining, 10);
		assert.equal(first.snapshot.accounts[0].percent, null);
		assert.match(first.snapshot.accounts[0].accountId, /^acct_[a-f0-9]{40}$/);
		assert.equal(first.activeAccountIds.length, 1);
		assert.equal(first.ledger.accounts.length, 1);
		assert.equal(first.cached, undefined);
		const cached = await refreshBalance({ ...customOf(h), force: false });
		assert.equal(cached.cached, true);
		assert.equal(fetchCalls.length, 1);
		// Distinct sample timestamps: two forced refreshes inside one millisecond are
		// the ledger's duplicate case and are correctly not counted as spend.
		await new Promise((resolve) => setTimeout(resolve, 5));
		amount = 8;
		const spent = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(spent.snapshot.accounts[0].remaining, 8);
		assert.equal(spent.ledger.accounts[0].observedSpend, "2.00000000");
	} finally { restore(); }
});
await test("失败保留相同endpoint最后成功余额并标旧", async () => {
	const h = balanceHarness({ url: "https://balance.test/ok", totalPath: "data.remaining" });
	let fail = false;
	const restore = installFetch(() => { if (fail) throw new TypeError("fetch failed"); return jsonResponse({ data: { remaining: 10 } }); });
	try {
		const first = await refreshBalance({ ...customOf(h), force: true });
		fail = true;
		const failed = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(failed.snapshot.ok, false);
		assert.equal(failed.snapshot.stale, true);
		assert.equal(failed.snapshot.accounts[0].remaining, 10);
		assert.equal(failed.snapshot.accounts[0].stale, true);
		assert.equal(failed.snapshot.fetchedAt, first.snapshot.fetchedAt);
		assert.equal(failed.snapshot.accounts[0].accountId, first.snapshot.accounts[0].accountId);
		assert.match(failed.snapshot.summary, /旧数据/);
		assert.equal(failed.snapshot.error.kind, "network");
		assert.ok(!JSON.stringify(failed.snapshot).includes("balance.test"));
		assert.equal((await h.service.read(h.config, { light: true })).accounts[0].stale, true);
	} finally { restore(); }
});
await test("更换endpoint或币种隔离旧快照与账户", async () => {
	const h = balanceHarness({ url: "https://balance.test/a", totalPath: "data.remaining" });
	const restore = installFetch((url) => jsonResponse({ data: { remaining: url.includes("/a") ? 10 : 20 } }));
	try {
		const first = await refreshBalance({ ...customOf(h), force: true });
		h.config = configOf({ ...h.config, balance: { ...h.config.balance, custom: { ...h.config.balance.custom, url: "https://balance.test/b" } } });
		const second = await refreshBalance({ ...customOf(h), force: false });
		assert.equal(second.cached, undefined);
		assert.equal(second.snapshot.accounts[0].remaining, 20);
		assert.notEqual(second.snapshot.accounts[0].accountId, first.snapshot.accounts[0].accountId);
		assert.equal(second.ledger.accounts.length, 1);
		assert.equal(second.ledger.accounts[0].accountId, second.snapshot.accounts[0].accountId);
		const stored = (await h.service.read(h.config)).accounts;
		assert.equal(stored.length, 2);
		h.config = configOf({ ...h.config, balance: { ...h.config.balance, custom: { ...h.config.balance.custom, currency: "USD" } } });
		const third = await refreshBalance({ ...customOf(h), force: false });
		assert.notEqual(third.snapshot.accounts[0].accountId, second.snapshot.accounts[0].accountId);
		assert.equal(third.snapshot.shape, "money");
	} finally { restore(); }
});
await test("密钥移除保留同endpoint旧值，密钥更换失败不继承", async () => {
	const h = balanceHarness({ url: "https://balance.test/ok", totalPath: "data.remaining" });
	let fail = false;
	const restore = installFetch(() => { if (fail) throw new TypeError("fetch failed"); return jsonResponse({ data: { remaining: 10 } }); });
	try {
		const first = await refreshBalance({ ...customOf(h), force: true });
		h.secrets.delete("customApiKey");
		const removed = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(removed.snapshot.error.kind, "missing_secret");
		assert.equal(removed.snapshot.accounts[0].remaining, 10);
		assert.equal(removed.snapshot.accounts[0].stale, true);
		assert.equal(removed.activeAccountIds.length, 0);
		h.secrets.set("customApiKey", "selftest-key-two");
		fail = true;
		const replaced = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(replaced.snapshot.ok, false);
		assert.equal(replaced.snapshot.accounts.length, 0);
		assert.deepEqual(replaced.activeAccountIds.length, 1);
		assert.notEqual(replaced.activeAccountIds[0], first.activeAccountIds[0]);
	} finally { restore(); }
});
await test("未配置URL明确提示且不写快照", async () => {
	const h = harness();
	const result = await refreshBalance({ callHost: h.callHost, config: h.config, accounting: h.service, force: true });
	assert.equal(result.skipped, "not_configured");
	assert.equal(result.snapshot.ok, false);
	assert.equal(result.snapshot.error.kind, "not_configured");
	assert.equal(result.snapshot.accounts.length, 0);
	assert.deepEqual(result.activeAccountIds, []);
	assert.equal(h.storage.has(BALANCE_KEY), false);
});
await test("money记录消费，points只显示数值", async () => {
	const h = balanceHarness({ url: "https://balance.test/ok", totalPath: "data.remaining", usedPath: "data.used", currency: "USD" });
	let remaining = 10, used = 30;
	const restore = installFetch(() => jsonResponse({ data: { remaining, used } }));
	try {
		const first = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(first.snapshot.percent, 75);
		assert.equal(first.snapshot.accounts[0].accountingEligible, true);
		remaining = 8; used = 32;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(second.ledger.accounts[0].observedSpend, "2.00000000");
		h.config = configOf({ ...h.config, balance: { ...h.config.balance, custom: { ...h.config.balance.custom, currency: "POINTS" } } });
		remaining = 5; used = 35;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const points = await refreshBalance({ ...customOf(h), force: true });
		assert.equal(points.snapshot.shape, "points");
		assert.equal(points.snapshot.accounts[0].accountingEligible, false);
		assert.equal(points.ledger.accounts[0].estimatedSpend, null);
		assert.equal(points.ledger.accounts[0].observedSpend, "0.00000000");
	} finally { restore(); }
});
await test("activeAccounts不联网即可确定当前账户身份", async () => {
	const h = balanceHarness({ url: "https://balance.test/ok", totalPath: "data.remaining" });
	const callsBefore = fetchCalls.length;
	const first = await activeAccounts({ callHost: h.callHost, config: h.config, accounting: h.service });
	assert.equal(first.configured, true);
	assert.match(first.accountIds[0], /^acct_[a-f0-9]{40}$/);
	const again = await activeAccounts({ callHost: h.callHost, config: h.config, accounting: h.cloneService() });
	assert.deepEqual(again.accountIds, first.accountIds);
	h.config = configOf({ ...h.config, accounting: { timeZone: "UTC" } });
	const other = await activeAccounts({ callHost: h.callHost, config: h.config, accounting: h.service });
	assert.notDeepEqual(other.accountIds, first.accountIds);
	assert.equal(fetchCalls.length, callsBefore);
});

process.stdout.write(`\n[accounting] ${passed} 通过，${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
