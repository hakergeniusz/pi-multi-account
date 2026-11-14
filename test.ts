/**
 * Test for pi-multi-account. Drives index.ts against a fake ExtensionAPI with
 * config files in temp dirs — no network, no real pi, no real accounts.
 * `bun test.ts`.
 *
 * Covers: global+project config merge, virtual provider registration
 * (naming, per-account keys, header merge, compat), account cycling,
 * failure-driven auto-switch with auto-retry, abort/router guards, the
 * exhausted-budget stop, session-state persistence, and $sessionId headers.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the agent dir before the module loads: getAgentDir() reads
// PI_CODING_AGENT_DIR (ENV_AGENT_DIR in pi-coding-agent).
const agentDir = mkdtempSync(join(tmpdir(), "multi-account-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");
const { default: activate } = await import("./index.ts");

// --- fixture config ----------------------------------------------------------

const globalConfig = {
	providers: {
		gprov: {
			baseUrl: "https://global.example.com/v1",
			api: "openai-completions",
			accounts: [
				{ label: "Global One", apiKey: "gkey-1" },
				{ label: "Global Two", apiKey: "gkey-2" },
			],
			models: [{ id: "big", name: "Big", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		},
	},
};
writeFileSync(join(agentDir, "multi-account.json"), JSON.stringify(globalConfig), "utf8");

// Project config adds a provider and overrides gprov's baseUrl (project wins).
const projectDir = mkdtempSync(join(tmpdir(), "multi-account-project-"));
const projectConfig = {
	providers: {
		gprov: {
			baseUrl: "https://project-override.example.com/v1",
			api: "openai-completions",
			accounts: [
				{ label: "Global One", apiKey: "gkey-1" },
				{ label: "Global Two", apiKey: "gkey-2" },
			],
			models: globalConfig.providers.gprov.models,
		},
		pprov: {
			name: "Pretty Provider",
			baseUrl: "https://pprov.example.com/v1",
			api: "openai-completions",
			headers: { "X-Provider": "prov" },
			authHeader: true,
			compat: { streamingUsage: true },
			accounts: [
				{ label: "Work Account!", apiKey: "pkey-1", headers: { "X-Account": "a1" } },
				{ label: "second", apiKey: "pkey-2" },
			],
			models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 50000, maxTokens: 2048 }],
			sessionHeaders: { "X-Session": "$sessionId" },
		},
	},
};
mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
writeFileSync(join(projectDir, CONFIG_DIR_NAME, "multi-account.json"), JSON.stringify(projectConfig), "utf8");

// --- fake pi -----------------------------------------------------------------

interface Registers {
	providers: Map<string, any>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void>; description: string }>;
	shortcuts: Map<string, unknown>;
	handlers: Record<string, (event: any, ctx: any) => unknown>;
	entries: Array<{ customType: string; data: unknown }>;
	setModels: unknown[];
	sentMessages: Array<{ text: string; options: unknown }>;
}

function makeFakePi(): { pi: unknown; reg: Registers } {
	const reg: Registers = { providers: new Map(), commands: new Map(), shortcuts: new Map(), handlers: {}, entries: [], setModels: [], sentMessages: [] };
	const pi = {
		registerProvider(name: string, config: unknown) {
			reg.providers.set(name, config);
		},
		registerCommand(name: string, opts: any) {
			reg.commands.set(name, opts);
		},
		registerShortcut(key: string, opts: unknown) {
			reg.shortcuts.set(key, opts);
		},
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			reg.handlers[event] = handler;
			return () => {};
		},
		appendEntry(customType: string, data?: unknown) {
			reg.entries.push({ customType, data });
		},
		async setModel(model: unknown) {
			reg.setModels.push(model);
			return true;
		},
		sendUserMessage(text: string, options: unknown) {
			reg.sentMessages.push({ text, options });
		},
	};
	return { pi, reg };
}

// --- fake ctx ----------------------------------------------------------------

interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

function makeCtx(options: {
	reg: Registers;
	model?: { provider: string; id: string; api?: string } | null;
	entries?: SessionEntry[];
	cwd?: string;
}): { ctx: any; notifications: Array<{ message: string; type?: string }>; statuses: Map<string, string | undefined> } {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const reg = options.reg;
	const ctx = {
		cwd: options.cwd ?? projectDir,
		model: options.model === undefined ? { provider: "pprov-work-account", id: "m1" } : options.model,
		modelRegistry: {
			find: (p: string, id: string) => (reg.providers.has(p) ? { provider: p, id } : undefined),
			getAll: () => [...reg.providers.keys()].map((p) => ({ provider: p, id: "m1" })),
		},
		sessionManager: {
			getSessionId: () => "session-42",
			getEntries: () => options.entries ?? reg.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (name: string, value: string | undefined) => statuses.set(name, value),
		},
	};
	return { ctx, notifications, statuses };
}

// --- helpers -----------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		passed++;
		console.log(`ok   ${name}`);
	} else {
		failed++;
		console.log(`FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
	}
}

const modelOn = (provider: string, id = "m1") => ({ provider, id, api: "openai-completions" });

// --- activation: global config loads in the factory --------------------------

const { pi, reg } = makeFakePi();
activate(pi as never);

check("factory registers global providers immediately", reg.providers.size === 2, [...reg.providers.keys()]);
check("account labels become provider slugs", reg.providers.has("gprov-global-one") && reg.providers.has("gprov-global-two"), [...reg.providers.keys()]);
check("global providers carry the project baseUrl later (merge happens on session_start)", reg.providers.get("gprov-global-one")!.baseUrl === "https://global.example.com/v1");
check("registers /account command and alt+a shortcut", reg.commands.has("account") && reg.shortcuts.has("alt+a"));

// --- session_start: merge, project override, provider config -----------------

const { ctx, notifications, statuses } = makeCtx({ reg });
await reg.handlers.session_start({ type: "session_start" }, ctx);

check("session_start announces both providers", notifications.at(-1)!.message.includes("Pretty Provider (2 accounts)") && notifications.at(-1)!.message.includes("gprov (2 accounts)"), notifications.at(-1));
check("project config overrides global baseUrl", reg.providers.get("gprov-global-one")!.baseUrl === "https://project-override.example.com/v1");
check("per-account api keys are wired", reg.providers.get("pprov-work-account")!.apiKey === "pkey-1" && reg.providers.get("pprov-second")!.apiKey === "pkey-2");

const workConfig = reg.providers.get("pprov-work-account")!;
check("provider display name uses the configured label", workConfig.name === "Pretty Provider (Work Account!)", workConfig.name);
check("provider headers merged, account headers win", workConfig.headers["X-Provider"] === "prov" && workConfig.headers["X-Account"] === "a1", workConfig.headers);
check("authHeader propagated", workConfig.authHeader === true);
check("compat merged into every model", workConfig.models[0].compat?.streamingUsage === true, workConfig.models[0]);

// Default account status is silent; selecting account 2 shows the status.
check("default account keeps the status clean", statuses.get("multi-account") === undefined, statuses.get("multi-account"));

await reg.handlers.model_select({ model: modelOn("pprov-second") }, ctx);
check("model_select on account 2 shows the account status", statuses.get("multi-account") === "acc: second", statuses.get("multi-account"));
await reg.handlers.model_select({ model: modelOn("pprov-work-account") }, ctx);
check("model_select back on account 1 clears the status", statuses.get("multi-account") === undefined, statuses.get("multi-account"));

// --- session headers with $sessionId -----------------------------------------

const headerEvent: { headers: Record<string, string> } = { headers: {} };
await reg.handlers.before_provider_headers(headerEvent, { ...ctx, model: modelOn("pprov-work-account") });
check("$sessionId expands to the session id", headerEvent.headers["X-Session"] === "session-42", headerEvent.headers);

// --- failure-driven auto-switch + settle-continue ------------------------------

// Capture the prompt, then fail on account 1 -> switches to account 2 and
// continues the interrupted task at the settle boundary (no user resend).
await reg.handlers.before_agent_start({ prompt: "please retry me" }, ctx);
check("error on account 1 switches to account 2", await (async () => {
	const before = reg.setModels.length;
	await reg.handlers.message_end(
		{ message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit exceeded" } },
		{ ...ctx, model: modelOn("pprov-work-account") },
	);
	return reg.setModels.length === before + 1 && (reg.setModels.at(-1) as any).provider === "pprov-second";
})());
check("switch is announced as continuing the task", /Work Account!.*second.*continuing/.test(notifications.at(-1)!.message), notifications.at(-1));
check("status tracks the new account", statuses.get("multi-account") === "acc: second", statuses.get("multi-account"));

// turn_end hands the failed assistant entry to the settle boundary; the settle
// handler drops it and keeps the agent loop running on the switched-to account.
await reg.handlers.turn_end(
	{ outcome: "error", message: { role: "assistant", stopReason: "error" }, messageEntryId: "entry-fail-1" },
	ctx,
);
const settleEvent = {
	outcome: "error",
	context: {
		contextEntries: [{ sourceEntry: { id: "entry-fail-1" } }, { sourceEntry: { id: "entry-other" } }],
		canContinue: true,
	},
};
const settle = await reg.handlers.agent_before_settle(settleEvent, ctx);
check("settle continues the task on the new account", (settle as any)?.continue === true, settle);
check("settle removes the failed assistant entry", JSON.stringify((settle as any)?.entries) === JSON.stringify([{ type: "context_edit", targetId: "entry-fail-1", replacement: null }]), (settle as any)?.entries);
check("no follow-up message is queued anymore", reg.sentMessages.length === 0, reg.sentMessages);
check("settle is consumed (second call is a no-op)", (await reg.handlers.agent_before_settle(settleEvent, ctx)) === undefined);

// A tool-using turn continues too — that is the point of settle-continue (the
// old toolsUsedInTurn gate is gone; mid-task switches need no user resend).
await reg.handlers.before_agent_start({ prompt: "second prompt" }, ctx);
await reg.handlers.message_end(
	{ message: { role: "assistant", stopReason: "error", errorMessage: "500 server error" } },
	{ ...ctx, model: modelOn("pprov-second") },
);
await reg.handlers.turn_end(
	{ outcome: "error", message: { role: "assistant", stopReason: "error" }, messageEntryId: "entry-fail-2" },
	ctx,
);
const toolSettle = await reg.handlers.agent_before_settle(
	{ outcome: "error", context: { contextEntries: [{ sourceEntry: { id: "entry-fail-2" } }], canContinue: true } },
	ctx,
);
check("tool-using turn still continues after the switch", (toolSettle as any)?.continue === true, toolSettle);

// autoRetry: false restores the manual path (config hot-reloads at session_start).
(projectConfig as any).autoRetry = false;
writeFileSync(join(projectDir, CONFIG_DIR_NAME, "multi-account.json"), JSON.stringify(projectConfig), "utf8");
await reg.handlers.session_start({ type: "session_start" }, ctx);
await reg.handlers.before_agent_start({ prompt: "manual retry" }, ctx);
await reg.handlers.message_end(
	{ message: { role: "assistant", stopReason: "error", errorMessage: "429 again" } },
	{ ...ctx, model: modelOn("pprov-second") },
);
check("autoRetry off switches but asks the user to resend", notifications.at(-1)!.message.includes("Resend your message"), notifications.at(-1));
check("autoRetry off does not continue", (await reg.handlers.agent_before_settle(
	{ outcome: "error", context: { contextEntries: [], canContinue: true } },
	ctx,
)) === undefined);
delete (projectConfig as any).autoRetry;
writeFileSync(join(projectDir, CONFIG_DIR_NAME, "multi-account.json"), JSON.stringify(projectConfig), "utf8");
await reg.handlers.session_start({ type: "session_start" }, ctx);

// Successful stop resets the attempt budget.
await reg.handlers.message_end({ message: { role: "assistant", stopReason: "stop" } }, ctx);

// Abort-like errors never rotate.
const beforeAbort = reg.setModels.length;
await reg.handlers.message_end(
	{ message: { role: "assistant", stopReason: "error", errorMessage: "Request was aborted by user" } },
	{ ...ctx, model: modelOn("pprov-second") },
);
check("abort errors do not rotate", reg.setModels.length === beforeAbort, reg.setModels.length);

// Virtual router models own their own rotation.
const routerCtx = { ...ctx, model: { provider: "pprov-second", id: "m1", api: "pi-virtual" } };
await reg.handlers.message_end(
	{ message: { role: "assistant", stopReason: "error", errorMessage: "429 quota" } },
	routerCtx,
);
check("virtual router models are left alone", reg.setModels.length === beforeAbort, reg.setModels.length);

// Exhausting every account stops the auto-switcher within one prompt: each
// failure switches and bumps the attempt counter (the settle drain models pi
// accepting the continue); once every account has been tried the stop notice
// fires, and the counter resets so a later prompt rotates again.
const exhaust = makeCtx({ reg, model: modelOn("gprov-global-one", "big") });
await reg.handlers.before_agent_start({ prompt: "exhaust me" }, exhaust.ctx);
let stopNotice = "";
for (let i = 0; i < 4; i++) {
	await reg.handlers.message_end(
		{ message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" } },
		exhaust.ctx,
	);
	await reg.handlers.turn_end(
		{ outcome: "error", message: { role: "assistant", stopReason: "error" }, messageEntryId: "entry-ex-" + i },
		exhaust.ctx,
	);
	await reg.handlers.agent_before_settle(
		{ outcome: "error", context: { contextEntries: [], canContinue: true } },
		exhaust.ctx,
	);
	const last = exhaust.notifications.at(-1)!.message;
	if (last.includes("Stopping auto-switch")) stopNotice = last;
}
check("all-accounts-failed surfaces a stop notice", stopNotice.includes("all 2 accounts on gprov failed"), stopNotice || exhaust.notifications);
check("budget resets for the next prompt", await (async () => {
	await reg.handlers.before_agent_start({ prompt: "fresh" }, exhaust.ctx);
	await reg.handlers.message_end(
		{ message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" } },
		exhaust.ctx,
	);
	return reg.setModels.length > beforeAbort;
})());

// --- /account command ----------------------------------------------------------
// Note: accountGroups and the attempt budget are module-level state, so a
// "no providers configured" scenario is not reachable in the same process.

const accountCmd = reg.commands.get("account")!;
{
	// cycle: work-account -> second.
	const c = makeCtx({ reg, model: modelOn("pprov-work-account") });
	await accountCmd.handler("cycle", c.ctx);
	check("/account cycle advances to account 2", (reg.setModels.at(-1) as any).provider === "pprov-second", reg.setModels.at(-1));
	check("cycle announces the pair", /Work Account!.*second/.test(c.notifications.at(-1)!.message), c.notifications.at(-1));
}

{
	// switch by (partial) label.
	const c = makeCtx({ reg, model: modelOn("pprov-second") });
	await accountCmd.handler("work", c.ctx);
	check("/account <label> switches by substring", (reg.setModels.at(-1) as any).provider === "pprov-work-account", reg.setModels.at(-1));
}

{
	// unknown label.
	const c = makeCtx({ reg, model: modelOn("pprov-work-account") });
	await accountCmd.handler("nope", c.ctx);
	check("unknown label reports an error", c.notifications.at(-1)!.message.includes('Account "nope" not found'), c.notifications.at(-1));
}

{
	// list: ui.select picks the last item (pprov/second) -> switch to it.
	const c = makeCtx({ reg, model: modelOn("pprov-work-account") });
	c.ctx.ui.select = async (_title: string, items: string[]) => items.at(-1)!;
	await accountCmd.handler("list", c.ctx);
	check("/account list switches to the selected account", (reg.setModels.at(-1) as any).provider === "pprov-second", reg.setModels.at(-1));
}

// --- state persistence + restore ----------------------------------------------

{
	const c = makeCtx({ reg, model: modelOn("pprov-second") });
	await reg.handlers.turn_start({}, c.ctx);
	const stateEntry = reg.entries.at(-1)!;
	const activeAccounts = (stateEntry.data as any).activeAccounts as Record<string, number>;
	check(
		"turn_start persists the active account map",
		stateEntry.customType === "multi-account-state" && activeAccounts.pprov === 1 && activeAccounts.gprov === 1,
		stateEntry,
	);

	// A fresh session restores the persisted account index.
	const reg2 = makeFakePi();
	activate(reg2.pi as never);
	const persisted = [{ type: "custom", customType: "multi-account-state", data: { activeAccounts: { pprov: 1 } } }];
	const c2 = makeCtx({ reg: reg2.reg, entries: persisted, model: modelOn("pprov") });
	await reg2.reg.handlers.session_start({ type: "session_start" }, c2.ctx);
	await reg2.reg.handlers.model_select({ model: modelOn("pprov") }, c2.ctx);
	check("restored session marks account 2 active in the status", c2.statuses.get("multi-account") === "acc: second", c2.statuses.get("multi-account"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
