/**
 * View-local task notices. Concatenated after sdk.js; never calls Pet or stores
 * bindings in plugin/global configuration. Only explicit context.narrator.id or
 * ids supplied by this view may be subscribed, each with both scope and filter.
 *
 * Source verified at NarraFork/NarraFork@6007ca13581cd1f3db8756f28fa5e53f22bd148c:
 * frontend/components/plugins/asset-shell.ts (single-object bridge arguments),
 * server/services/plugin-ui-host.ts (UI poll returns PublicEvent[]),
 * server/lib/plugins/protocol.ts (canonical poll object and public envelope),
 * server/services/plugin-event-gateway.ts (allowlisted event mapper),
 * server/lib/event-bus.ts (attention reasons; tools report success/fail only).
 */
const TaskEvents = (() => {
	const TOPICS = Object.freeze([
		"narrafork.narrator.lifecycle",
		"narrafork.narrator.tool.changed",
		"narrafork.narrator.attention",
		"narrafork.narrator.permission.changed",
	]);
	const POLL_MS = 1000;
	const PAGE_SIZE = 50;
	const MAX_PAGES = 4;
	const REQUEST_MS = 5000;
	const WAIT_LEASE_MS = 30000;
	const MAX_EVENT_IDS = 512;
	const LIMITATIONS = Object.freeze({
		answer: "当前公开 API 不能可靠识别等待回答；waiting 或 AskUserQuestion 运行不代表正在等待回答。",
		turnCost: "宿主未公开逐轮费用或 token；此模块不估算费用，账户余额另行显示。",
	});
	const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
	const id = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
	const label = (value) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 40) : "";
	const failure = (code, message) => Object.assign(new Error(message), { code });
	const noticeKey = (...parts) => "task:" + parts.map((part) => encodeURIComponent(String(part))).join(":");

	function errorInfo(error) {
		const code = typeof error?.code === "string" ? error.code.slice(0, 80) : "HOST_UNAVAILABLE";
		if (["PERMISSION_DENIED", "FORBIDDEN", "CAPABILITY_DENIED", "UNAUTHORIZED"].includes(code) || error?.message === "PERMISSION_DENIED") {
			return { capability: "denied", error: { code: "PERMISSION_DENIED", message: "任务事件权限未获准；请在宿主中检查 event.subscribe 授权。" }, blocked: true };
		}
		if (["METHOD_NOT_FOUND", "NOT_SUPPORTED", "BRIDGE_UNAVAILABLE", "PLUGIN_DISABLED"].includes(code)) {
			return { capability: "unavailable", error: { code, message: "当前宿主未提供可用的任务事件接口。" }, blocked: true };
		}
		return { capability: "degraded", error: { code, message: code === "STALE_PERMISSION" ? "授权等待状态已过期，已撤销提示并重新连接。" : "任务事件暂不可用；不可靠状态已清除，正在重连。" }, blocked: false };
	}

	function isEnvelope(event) {
		return record(event) && event.schema === "narrafork.public-event" && event.schemaVersion === 1
			&& id(event.eventId) !== null && typeof event.topic === "string" && record(event.data)
			&& typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt))
			&& ["state", "lifecycle", "progress", "attention", "audit"].includes(event.eventClass)
			&& ["public", "user_scoped", "admin_scoped"].includes(event.redaction)
			&& (event.deliverySeq === undefined || (Number.isSafeInteger(event.deliverySeq) && event.deliverySeq > 0));
	}

	function pollPage(value, subscriptionId) {
		// The pinned UI host returns an array; the same revision's canonical public
		// protocol specifies an object. Support both, never a guessed RPC wrapper.
		if (Array.isArray(value) && value.length <= PAGE_SIZE) {
			return { events: value, hasMore: value.length === PAGE_SIZE, resyncRequired: false };
		}
		if (record(value) && value.subscriptionId === subscriptionId && Array.isArray(value.events)
			&& value.events.length <= PAGE_SIZE && typeof value.hasMore === "boolean"
			&& (value.resyncRequired === undefined || typeof value.resyncRequired === "boolean")) {
			return value;
		}
		throw failure("INVALID_EVENT_RESPONSE", "事件轮询返回格式不匹配");
	}

	return class TaskEvents {
		/** config is config.tasks, not the whole pet configuration. */
		constructor({ config = { enabled: true }, onNotice, onClear, onState, sdk = SDK } = {}) {
			this.sdk = sdk;
			this.enabled = config?.enabled !== false;
			this.onNotice = onNotice;
			this.onClear = onClear;
			this.onState = onState;
			this.started = false;
			this.destroyed = false;
			this.visible = typeof document === "undefined" || document.visibilityState !== "hidden";
			this.explicit = null;
			this.scope = [];
			this.records = new Map();
			this.histories = new Map();
			this.dismissed = new Set();
			this.notices = new Map();
			this.requests = new Set();
			this.generation = 0;
			this.timer = null;
			this.stateStamp = "";
			this.capability = "checking";
			this.error = null;
			this.visibilityListener = () => this.setVisible(document.visibilityState !== "hidden");
		}

		start() {
			if (this.destroyed) return Promise.resolve();
			if (this.started) return this.startup ?? Promise.resolve();
			this.started = true;
			if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", this.visibilityListener);
			this.startup = this._restart();
			return this.startup;
		}

		configure(config) {
			if (this.destroyed) return Promise.resolve();
			const next = config?.enabled !== false;
			if (next === this.enabled) return Promise.resolve();
			this.enabled = next;
			return this._restart();
		}

		/** Explicit replacement, max three known ids; [] also removes the auto binding. */
		setAssociations(entries) {
			if (this.destroyed) return { ok: false, error: "视图已销毁" };
			if (!Array.isArray(entries) || entries.length > 3) return { ok: false, error: "本视图最多关联 3 个已知叙述者" };
			const seen = new Set();
			const next = [];
			for (const item of entries) {
				const narratorId = id(item?.narratorId);
				if (!narratorId || seen.has(narratorId)) return { ok: false, error: "叙述者 ID 无效或重复" };
				seen.add(narratorId);
				next.push({ narratorId, alias: label(item.alias) || "关联叙述者", source: "explicit" });
			}
			this.explicit = next;
			this.scope = next;
			void this._restart();
			return { ok: true };
		}

		setVisible(visible) {
			if (this.destroyed || this.visible === Boolean(visible)) return;
			this.visible = Boolean(visible);
			void this._restart();
		}

		retry() {
			return this.destroyed ? Promise.resolve() : this._restart();
		}

		dismiss(noticeId) {
			if (this.destroyed || typeof noticeId !== "string") return;
			this.dismissed.add(noticeId);
			this._clearNotice(noticeId);
		}

		getState() {
			return {
				enabled: this.enabled,
				capability: this.capability,
				error: this.error ? { ...this.error } : null,
				scope: this.scope.map((entry) => ({ ...entry })),
				tasks: [...this.records.values()].map((entry) => ({
					narratorId: entry.narratorId, alias: entry.alias, status: entry.status,
					waitingPermission: entry.pending.size > 0, reliable: entry.reliable,
					capability: entry.capability, error: entry.error ? { ...entry.error } : null,
				})),
				limitations: { ...LIMITATIONS },
			};
		}

		destroy() {
			if (this.destroyed) return;
			// Clear our currently visible notices once, then forbid every late callback.
			this._invalidate();
			this.destroyed = true;
			if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", this.visibilityListener);
			this.histories.clear();
			this.dismissed.clear();
			this.onNotice = this.onClear = this.onState = null;
		}

		_alive(generation) {
			return !this.destroyed && this.started && this.enabled && this.visible && this.generation === generation;
		}

		_call(callback, value) {
			if (!this.destroyed && typeof callback === "function") {
				try { callback(value); } catch { /* A stage presentation error cannot kill polling. */ }
			}
		}

		_emit() {
			if (this.destroyed) return;
			const state = this.getState();
			const stamp = JSON.stringify(state);
			if (stamp !== this.stateStamp) {
				this.stateStamp = stamp;
				this._call(this.onState, state);
			}
		}

		_release(api, subscriptionId) {
			if (!id(subscriptionId)) return;
			try { Promise.resolve(api.unsubscribe({ subscriptionId })).catch(() => {}); } catch { /* Best effort after host loss. */ }
		}

		_bounded(promise, onLate) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const finish = (fn, value) => {
					if (settled) return false;
					settled = true;
					clearTimeout(timer);
					this.requests.delete(cancel);
					fn(value);
					return true;
				};
				const cancel = () => finish(reject, failure("CANCELLED", "任务视图已改变"));
				const timer = setTimeout(() => finish(reject, failure("TIMEOUT", "任务事件请求超时")), REQUEST_MS);
				this.requests.add(cancel);
				Promise.resolve(promise).then(
					(value) => { if (!finish(resolve, value)) { try { onLate?.(value); } catch {} } },
					(error) => finish(reject, error),
				);
			});
		}

		_invalidate() {
			this.generation += 1;
			if (this.timer !== null) clearTimeout(this.timer);
			this.timer = null;
			for (const cancel of [...this.requests]) cancel();
			for (const item of this.records.values()) {
				if (item.subscriptionId) this._release(item.api, item.subscriptionId);
				this._clearRecord(item, false);
			}
			this.records.clear();
			return this.generation;
		}

		async _restart() {
			const generation = this._invalidate();
			this.error = null;
			if (!this.started || !this.enabled || !this.visible) {
				this.capability = !this.enabled ? "disabled" : !this.visible ? "hidden" : "checking";
				this._emit();
				return;
			}
			this.capability = "checking";
			this._emit();
			if (!this._alive(generation)) return;
			let api;
			try { api = this.sdk.events?.(); } catch {}
			if (!api) {
				this.capability = "unavailable";
				this.error = { code: "METHOD_NOT_FOUND", message: "宿主缺少 events.subscribe/poll/unsubscribe，任务提示已单独降级。" };
				this._emit();
				return;
			}
			if (this.explicit === null) {
				try {
					if (typeof this.sdk.getContextSafe !== "function") throw failure("METHOD_NOT_FOUND", "缺少视图上下文接口");
					const context = await this._bounded(this.sdk.getContextSafe());
					if (!this._alive(generation)) return;
					if (!context?.ok) throw context?.error ?? failure("CONTEXT_UNAVAILABLE", "缺少视图上下文");
					const narratorId = id(context.value?.narrator?.id);
					this.scope = narratorId ? [{ narratorId, alias: "当前叙述者", source: "context" }] : [];
				} catch (error) {
					if (!this._alive(generation)) return;
					this.scope = [];
					const info = errorInfo(error);
					this.capability = info.capability;
					this.error = { code: info.error.code, message: "无法确认当前视图叙述者；未自动订阅，可手动关联已知 ID。" };
					this._emit();
					return;
				}
			} else this.scope = this.explicit;
			if (!this._alive(generation)) return;
			for (const entry of this.scope) {
				if (!this.histories.has(entry.narratorId)) this.histories.set(entry.narratorId, { events: new Set(), closedRequests: new Set(), requestNotices: new Map() });
				this.records.set(entry.narratorId, {
					...entry, api, subscriptionId: null, sequence: 0, status: "unknown", reliable: false,
					pending: new Map(), attention: new Map(), retryAt: 0, failures: 0, blocked: false,
					capability: "checking", error: null, history: this.histories.get(entry.narratorId),
				});
			}
			if (this.records.size === 0) {
				this.capability = "unbound";
				this._emit();
				return;
			}
			await this._tick(generation);
		}

		async _tick(generation) {
			if (!this._alive(generation)) return;
			await Promise.all([...this.records.values()].map((item) => this._step(item, generation)));
			if (!this._alive(generation)) return;
			const items = [...this.records.values()];
			const problem = items.find((item) => item.error);
			this.error = problem?.error ?? null;
			this.capability = items.every((item) => item.subscriptionId) ? "available"
				: items.some((item) => item.subscriptionId) ? "degraded"
					: problem?.capability ?? "checking";
			this._emit();
			if (this._alive(generation) && items.some((item) => !item.blocked)) {
				this.timer = setTimeout(() => { this.timer = null; void this._tick(generation); }, POLL_MS);
			}
		}

		async _step(item, generation) {
			if (item.blocked || Date.now() < item.retryAt || !this._alive(generation)) return;
			try {
				if (!item.subscriptionId) {
					const result = await this._bounded(item.api.subscribe({
						topics: [...TOPICS], mode: "live",
						scope: { narratorId: item.narratorId }, filter: { narratorIds: [item.narratorId] },
						delivery: { transport: "poll", queueEvents: 200, queueBytes: 131072, maxRatePerSecond: 50 },
					}), (late) => this._release(item.api, late?.subscriptionId));
					if (!this._alive(generation)) { this._release(item.api, result?.subscriptionId); return; }
					if (!id(result?.subscriptionId)) throw failure("INVALID_EVENT_RESPONSE", "缺少订阅 ID");
					item.subscriptionId = result.subscriptionId;
					item.sequence = 0;
					item.capability = "available";
					item.error = null;
					return;
				}
				if ([...item.pending.values()].some((pending) => Date.now() - pending.raisedAt >= WAIT_LEASE_MS)) {
					throw failure("STALE_PERMISSION", "未收到可确认的授权等待更新");
				}
				for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
					const value = await this._bounded(item.api.poll({ subscriptionId: item.subscriptionId, limit: PAGE_SIZE }));
					if (!this._alive(generation)) return;
					const page = pollPage(value, item.subscriptionId);
					if (page.resyncRequired || page.events.some((event) => isEnvelope(event)
						&& ["narrafork.events.overflow", "narrafork.events.resync_required"].includes(event.topic)
						&& event.data.subscriptionId === item.subscriptionId)) {
						throw failure("EVENT_RESYNC_REQUIRED", "事件流已丢失状态");
					}
					for (const event of page.events) {
						if (!this._alive(generation)) return;
						this._event(item, event);
					}
					item.failures = 0;
					if (!page.hasMore) break;
				}
			} catch (error) {
				if (!this._alive(generation)) return;
				if (item.subscriptionId) this._release(item.api, item.subscriptionId);
				item.subscriptionId = null;
				this._clearRecord(item, false);
				const info = errorInfo(error);
				Object.assign(item, info);
				item.failures += 1;
				item.retryAt = Date.now() + Math.min(30000, POLL_MS * 2 ** Math.min(item.failures - 1, 5));
			}
		}

		_event(item, event) {
			if (!isEnvelope(event) || !TOPICS.includes(event.topic)) return;
			// Check every provided identity, not a convenient OR of data and resource.
			if (event.data.narratorId !== item.narratorId) return;
			if (event.resource && (event.resource.type !== "narrator" || event.resource.id !== item.narratorId
				|| (event.resource.narratorId !== undefined && event.resource.narratorId !== item.narratorId))) return;
			if (event.deliverySeq !== undefined && event.deliverySeq <= item.sequence) return;
			if (event.deliverySeq !== undefined) item.sequence = event.deliverySeq;
			if (item.history.events.has(event.eventId)) return;
			item.history.events.add(event.eventId);
			if (item.history.events.size > MAX_EVENT_IDS) item.history.events.delete(item.history.events.values().next().value);
			const data = event.data;
			if (event.topic === "narrafork.narrator.permission.changed") {
				if (data.state === "pending" && id(data.requestId)) this._permission(item, event, data.requestId);
				return; // There is no public approved/denied permission event in this version.
			}
			if (event.topic === "narrafork.narrator.attention") {
				if (!["waiting_permission", "done", "error"].includes(data.reason)) return;
				if (data.state === "resolved") {
					if (data.reason === "waiting_permission") this._clearPending(item, true);
					else this._clearAttention(item, data.reason);
					item.reliable = true;
				} else if (data.state === "raised") {
					if (data.reason === "waiting_permission") this._permission(item, event, null);
					else if (!(data.reason === "done" && data.backgroundWorkActive === true)) {
						this._clearPending(item, true);
						this._clearAttention(item, data.reason === "done" ? "error" : "done");
						this._attention(item, data.reason, event);
					}
				}
				return;
			}
			if (event.topic === "narrafork.narrator.lifecycle") {
				if (["idle", "working", "waiting", "archived"].includes(data.status)) {
					item.status = data.status;
					item.reliable = true;
					if (data.status !== "waiting") this._clearPending(item, true);
					if (data.status === "working" || data.status === "archived") {
						this._clearAttention(item, "done");
						this._clearAttention(item, "error");
					}
				} else if (data.changeKind === "error" && data.status === "error") {
					this._clearPending(item, true);
					this._attention(item, "error", event);
				}
				return;
			}
			// Tools expose terminal success/fail metadata only; neither running nor
			// the name AskUserQuestion supplies a trustworthy question-wait signal.
			if (!id(data.toolUseId) || !["success", "fail"].includes(data.status)) return;
			if (data.status === "fail") this._attention(item, "error", event, data.toolUseId);
			else if (item.attention.get("error")?.toolUseId === data.toolUseId) this._clearAttention(item, "error");
		}

		_permission(item, event, requestId) {
			if (requestId && item.history.closedRequests.has(requestId)) return;
			item.reliable = true;
			if (!requestId && item.pending.size > 0) return;
			if (requestId && item.pending.has(requestId)) return;
			const generic = item.pending.get("");
			if (requestId && generic) {
				item.pending.delete("");
				item.pending.set(requestId, generic);
				item.history.requestNotices.set(requestId, generic.id);
				return;
			}
			if (item.pending.size >= 16) throw failure("EVENT_RESYNC_REQUIRED", "待处理授权过多");
			const noticeId = (requestId && item.history.requestNotices.get(requestId))
				|| noticeKey(item.narratorId, "permission", requestId || event.eventId);
			if (requestId) item.history.requestNotices.set(requestId, noticeId);
			item.pending.set(requestId || "", { id: noticeId, raisedAt: Date.now() });
			this._notice(item, { id: noticeId, kind: "permission", text: "需要你在宿主中处理授权", sticky: true, ...(requestId ? { requestId } : {}) });
		}

		_attention(item, kind, event, toolUseId) {
			item.reliable = true;
			if (item.attention.has(kind)) return;
			const noticeId = noticeKey(item.narratorId, kind, event.eventId);
			item.attention.set(kind, { id: noticeId, toolUseId });
			this._notice(item, { id: noticeId, kind, text: kind === "done" ? "本轮任务已完成" : toolUseId ? "工具执行失败，请查看宿主" : "任务执行遇到错误，请查看宿主", sticky: false });
		}

		_notice(item, notice) {
			if (this.dismissed.has(notice.id) || this.notices.has(notice.id)) return;
			const value = { ...notice, narratorId: item.narratorId, alias: item.alias };
			this.notices.set(value.id, value);
			this._call(this.onNotice, { ...value });
		}

		_clearNotice(noticeId) {
			if (!this.notices.delete(noticeId)) return;
			this._call(this.onClear, noticeId);
		}

		_clearPending(item, close) {
			for (const [requestId, pending] of item.pending) {
				if (close && requestId) item.history.closedRequests.add(requestId);
				this._clearNotice(pending.id);
			}
			item.pending.clear();
		}

		_clearAttention(item, kind) {
			const active = item.attention.get(kind);
			item.attention.delete(kind);
			if (active) this._clearNotice(active.id);
		}

		_clearRecord(item, close) {
			this._clearPending(item, close);
			this._clearAttention(item, "done");
			this._clearAttention(item, "error");
			item.status = "unknown";
			item.reliable = false;
		}
	};
})();
