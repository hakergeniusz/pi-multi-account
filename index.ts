/**
 * Multi-Account Extension for Pi
 * Allows multiple API accounts for the same provider to double rate limits.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface AccountConfig {
  label: string;
  apiKey: string;
  headers?: Record<string, string>;
}

interface ProviderAccountConfig {
  name?: string;
  baseUrl: string;
  api: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  accounts: AccountConfig[];
  models?: ProviderModelConfig[];
  modelUrl?: string;
  sessionHeaders?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface MultiAccountConfig {
  providers: Record<string, ProviderAccountConfig>;
  cycleShortcut?: string;
  autoSwitchOnFailure?: boolean;
  autoRetry?: boolean;
}

interface AccountGroup {
  providerName: string;
  providerLabel: string;
  accounts: AccountConfig[];
  models: ProviderModelConfig[];
  sessionHeaders?: Record<string, string>;
  virtualProviderNames: string[];
}

let config: MultiAccountConfig = { providers: {} };
let accountGroups = new Map<string, AccountGroup>();
let activeAccountIndices = new Map<string, number>();
const STATE_ENTRY_TYPE = "multi-account-state";
let lastUserPrompt: string | undefined = undefined;
let toolsUsedInTurn = false;
let autoSwitchAttempts = 0;
let lastAutoSwitchTime = 0;

function loadConfig(cwd: string): MultiAccountConfig {
  const globalPath = join(getAgentDir(), "multi-account.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "multi-account.json");
  let globalConfig: MultiAccountConfig = { providers: {} };
  let projectConfig: MultiAccountConfig = { providers: {} };
  if (existsSync(globalPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
    } catch (e) {
      console.error("[multi-account] Failed to load " + globalPath, e);
    }
  }
  if (existsSync(projectPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
    } catch (e) {
      console.error("[multi-account] Failed to load " + projectPath, e);
    }
  }
  return {
    providers: { ...globalConfig.providers, ...projectConfig.providers },
    cycleShortcut: projectConfig.cycleShortcut || globalConfig.cycleShortcut || "alt+a",
  };
}

function sanitizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function getVirtualProviderName(providerName: string, account: AccountConfig, index: number): string {
  if (account.label) {
    const slug = sanitizeLabel(account.label);
    return slug ? providerName + "-" + slug : providerName + "-acc" + index;
  }
  return providerName + "-acc" + index;
}

function buildAccountGroups(pi: ExtensionAPI, cwd: string): Map<string, AccountGroup> {
  config = loadConfig(cwd);
  const groups = new Map<string, AccountGroup>();
  for (const providerName of Object.keys(config.providers)) {
    const pc = config.providers[providerName];
    if (!pc.accounts || pc.accounts.length === 0) continue;
    let models: ProviderModelConfig[] = [];
    if (pc.modelUrl) {
      // dynamic, handled below
    } else if (pc.models && pc.models.length > 0) {
      models = pc.models;
    } else {
      continue;
    }
    const virtualProviderNames: string[] = [];
    for (let i = 0; i < pc.accounts.length; i++) {
      const account = pc.accounts[i];
      const vName = getVirtualProviderName(providerName, account, i);
      virtualProviderNames.push(vName);
      const pConfig: ProviderConfig = {
        name: pc.name ? pc.name + " (" + account.label + ")" : providerName + " (" + account.label + ")",
        baseUrl: pc.baseUrl,
        apiKey: account.apiKey,
        api: pc.api as Api,
        models: models.map((m) => ({ ...m })),
      };
      if (pc.headers) pConfig.headers = { ...pc.headers };
      if (account.headers) pConfig.headers = { ...(pConfig.headers || {}), ...account.headers };
      if (pc.authHeader !== undefined) pConfig.authHeader = pc.authHeader;
      if (pc.compat) {
        pConfig.models = pConfig.models!.map((m) => ({
          ...m,
          compat: { ...(pc.compat as object), ...((m.compat as object) || {}) },
        }));
      }
      if (pc.modelUrl) {
        const modelUrl = pc.modelUrl;
        pConfig.models = [];
        pConfig.refreshModels = async (ctx: { signal: AbortSignal }) => {
          const res = await fetch(modelUrl, { signal: ctx.signal });
          if (!res.ok) throw new Error("Failed to fetch models: " + res.status);
          const data = (await res.json()) as { data: Array<{ id: string; name?: string }> };
          return data.data.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: false,
            input: ["text"] as Array<"text" | "image">,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }));
        };
      }
      pi.registerProvider(vName, pConfig);
    }
    groups.set(providerName, {
      providerName,
      providerLabel: pc.name || providerName,
      accounts: pc.accounts,
      models,
      sessionHeaders: pc.sessionHeaders,
      virtualProviderNames,
    });
  }
  return groups;
}

function findGroupByProvider(groups: Map<string, AccountGroup>, provider: string): AccountGroup | undefined {
  for (const g of groups.values()) {
    if (g.virtualProviderNames.indexOf(provider) >= 0) return g;
  }
  return groups.get(provider);
}

function getAccountIndex(group: AccountGroup, provider: string): number {
  const idx = group.virtualProviderNames.indexOf(provider);
  return idx >= 0 ? idx : 0;
}

async function switchToAccount(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  group: AccountGroup,
  targetIndex: number
): Promise<boolean> {
  const currentModel = ctx.model;
  const currentModelId = currentModel ? currentModel.id : undefined;
  const targetProvider = group.virtualProviderNames[targetIndex];
  if (currentModelId) {
    const tm = ctx.modelRegistry.find(targetProvider, currentModelId);
    if (tm) return await pi.setModel(tm);
  }
  if (group.models.length > 0) {
    const tm = ctx.modelRegistry.find(targetProvider, group.models[0].id);
    if (tm) return await pi.setModel(tm);
  }
  const all = ctx.modelRegistry.getAll();
  const fb = all.find((m) => m.provider === targetProvider);
  if (fb) return await pi.setModel(fb);
  return false;
}

async function cycleToNextAccount(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const currentModel = ctx.model;
  const provider = currentModel ? currentModel.provider : "";
  const group = findGroupByProvider(accountGroups, provider);
  if (!group || group.accounts.length <= 1) {
    ctx.ui.notify("Current model is not on a multi-account provider", "warning");
    return;
  }
  let currentIdx: number;
  if (currentModel && group.virtualProviderNames.indexOf(currentModel.provider) >= 0) {
    currentIdx = getAccountIndex(group, currentModel.provider);
  } else {
    currentIdx = activeAccountIndices.get(group.providerName) || 0;
  }
  const nextIdx = (currentIdx + 1) % group.accounts.length;
  const ok = await switchToAccount(pi, ctx, group, nextIdx);
  if (ok) {
    activeAccountIndices.set(group.providerName, nextIdx);
    ctx.ui.notify("Switched " + group.providerLabel + ": " + group.accounts[currentIdx].label + " -> " + group.accounts[nextIdx].label, "info");
    updateStatus(ctx, { provider: group.virtualProviderNames[nextIdx] });
  } else {
    ctx.ui.notify("Failed to switch account", "error");
    updateStatus(ctx);
  }
}

const NON_RETRYABLE_PATTERNS = [
  "context_length_exceeded", "context length", "context overflow",
  "too many tokens", "maximum context", "context window",
  "aborted", "cancelled", "canceled", "user aborted", "interrupted",
  "invalid request", "bad request",
];
const RETRYABLE_PATTERNS = [
  "429", "rate limit", "rate_limit", "ratelimit", "too many requests",
  "quota", "exceeded", "insufficient", "out of credit", "no credits",
  "out of budget", "insufficient_quota", "balance",
  "401", "unauthorized", "invalid api key", "incorrect api key",
  "invalid_api_key", "authentication", "invalid token", "expired token",
  "403", "forbidden", "access denied",
  "freetiererror", "freeusagelimiterror", "gousagelimiterror",
  "monthly usage limit",
  "overloaded", "capacity", "try again", "temporarily unavailable",
  "service unavailable", "bad gateway", "gateway timeout",
  "500", "502", "503", "504", "internal error",
  "billing",
];

function isNonRetryableError(err: string): boolean {
  for (const p of NON_RETRYABLE_PATTERNS) {
    if (err.indexOf(p) >= 0) return true;
  }
  return false;
}

function isRetryableError(err: string): boolean {
  for (const p of RETRYABLE_PATTERNS) {
    if (err.indexOf(p) >= 0) return true;
  }
  return false;
}

function updateStatus(ctx: ExtensionContext, modelOverride?: { provider: string }): void {
  const model = (modelOverride ?? ctx.model) as ExtensionContext["model"];
  if (!model) {
    ctx.ui.setStatus("multi-account", undefined);
    return;
  }
  const group = findGroupByProvider(accountGroups, model.provider);
  if (group) {
    let idx: number;
    if (group.virtualProviderNames.indexOf(model.provider) >= 0) {
      idx = getAccountIndex(group, model.provider);
    } else {
      idx = activeAccountIndices.get(group.providerName) || 0;
    }
    const label = group.accounts[idx] ? group.accounts[idx].label : "Account " + (idx + 1);
    // Account index 0 is the default everywhere in this extension
    // (getAccountIndex falls back to it, and activeAccountIndices defaults to it),
    // so showing "acc: Account1" on every turn is pure noise. Surface the status
    // only while a non-default account is active, since that is the case that
    // actually changes which key/rate-limit pool is in use.
    ctx.ui.setStatus("multi-account", idx === 0 ? undefined : "acc: " + label);
  } else {
    ctx.ui.setStatus("multi-account", undefined);
  }
}

function restoreState(ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type: string; customType?: string; data?: { activeAccounts?: Record<string, number> } };
    if (e.type === "custom" && e.customType === STATE_ENTRY_TYPE && e.data && e.data.activeAccounts) {
      for (const k of Object.keys(e.data.activeAccounts)) {
        activeAccountIndices.set(k, e.data.activeAccounts[k]);
      }
      break;
    }
  }
}

function loadGlobalConfig(): MultiAccountConfig {
  const globalPath = join(getAgentDir(), "multi-account.json");
  let globalConfig: MultiAccountConfig = { providers: {} };
  if (existsSync(globalPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
    } catch (e) {
      console.error("[multi-account] Failed to load " + globalPath, e);
    }
  }
  return globalConfig;
}

function registerProvidersFromConfig(pi: ExtensionAPI, cfg: MultiAccountConfig): Map<string, AccountGroup> {
  const savedConfig = config;
  config = cfg;
  const groups = buildAccountGroupsInternal(pi);
  config = savedConfig;
  return groups;
}

function buildAccountGroupsInternal(pi: ExtensionAPI): Map<string, AccountGroup> {
  const groups = new Map<string, AccountGroup>();
  for (const providerName of Object.keys(config.providers)) {
    const pc = config.providers[providerName];
    if (!pc.accounts || pc.accounts.length === 0) continue;
    let models: ProviderModelConfig[] = [];
    if (pc.modelUrl) {
    } else if (pc.models && pc.models.length > 0) {
      models = pc.models;
    } else {
      continue;
    }
    const virtualProviderNames: string[] = [];
    for (let i = 0; i < pc.accounts.length; i++) {
      const account = pc.accounts[i];
      const vName = getVirtualProviderName(providerName, account, i);
      virtualProviderNames.push(vName);
      const pConfig: ProviderConfig = {
        name: pc.name ? pc.name + " (" + account.label + ")" : providerName + " (" + account.label + ")",
        baseUrl: pc.baseUrl,
        apiKey: account.apiKey,
        api: pc.api as Api,
        models: models.map((m) => ({ ...m })),
      };
      if (pc.headers) pConfig.headers = { ...pc.headers };
      if (account.headers) pConfig.headers = { ...(pConfig.headers || {}), ...account.headers };
      if (pc.authHeader !== undefined) pConfig.authHeader = pc.authHeader;
      if (pc.compat) {
        pConfig.models = pConfig.models!.map((m) => ({
          ...m,
          compat: { ...(pc.compat as object), ...((m.compat as object) || {}) },
        }));
      }
      if (pc.modelUrl) {
        const modelUrl = pc.modelUrl;
        pConfig.models = [];
        pConfig.refreshModels = async (ctx: { signal: AbortSignal }) => {
          const res = await fetch(modelUrl, { signal: ctx.signal });
          if (!res.ok) throw new Error("Failed to fetch models: " + res.status);
          const data = (await res.json()) as { data: Array<{ id: string; name?: string }> };
          return data.data.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: false,
            input: ["text"] as Array<"text" | "image">,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }));
        };
      }
      pi.registerProvider(vName, pConfig);
    }
    groups.set(providerName, {
      providerName,
      providerLabel: pc.name || providerName,
      accounts: pc.accounts,
      models,
      sessionHeaders: pc.sessionHeaders,
      virtualProviderNames,
    });
  }
  return groups;
}

export default function (pi: ExtensionAPI): void {
  try {
    const globalCfg = loadGlobalConfig();
    if (globalCfg.providers && Object.keys(globalCfg.providers).length > 0) {
      const savedConfig = config;
      config = globalCfg;
      const groups = buildAccountGroupsInternal(pi);
      for (const entry of groups) {
        accountGroups.set(entry[0], entry[1]);
      }
      config = savedConfig;
    }
  } catch (e) {
    console.error("[multi-account] Factory init failed", e);
  }

  pi.on("session_start", async (_event, ctx) => {
    accountGroups = buildAccountGroups(pi, ctx.cwd);
    restoreState(ctx);
    updateStatus(ctx);
    if (accountGroups.size > 0) {
      const parts: string[] = [];
      for (const g of accountGroups.values()) {
        parts.push(g.providerLabel + " (" + g.accounts.length + " accounts)");
      }
      ctx.ui.notify("Multi-account loaded: " + parts.join(", "), "info");
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const group = findGroupByProvider(accountGroups, event.model.provider);
    if (group && group.virtualProviderNames.indexOf(event.model.provider) >= 0) {
      activeAccountIndices.set(group.providerName, getAccountIndex(group, event.model.provider));
    }
    updateStatus(ctx, event.model);
  });

  pi.on("before_agent_start", async (event) => {
    lastUserPrompt = event.prompt;
    toolsUsedInTurn = false;
  });

  pi.on("tool_execution_start", async () => {
    toolsUsedInTurn = true;
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (msg.role !== "assistant") return;
    if (msg.stopReason === "stop" || msg.stopReason === "toolUse" || msg.stopReason === "length") {
      autoSwitchAttempts = 0;
      return;
    }
    if (msg.stopReason !== "error") return;
    if (config.autoSwitchOnFailure === false) return;
    if (accountGroups.size === 0) return;
    const now = Date.now();
    if (now - lastAutoSwitchTime < 2000) return;
    const err = (msg.errorMessage || "").toLowerCase();
    if (!err) return;
    if (isNonRetryableError(err)) return;
    if (!isRetryableError(err)) return;
    const model = ctx.model;
    if (!model) return;
    const group = findGroupByProvider(accountGroups, model.provider);
    if (!group || group.accounts.length <= 1) return;
    let currentIdx: number;
    if (group.virtualProviderNames.indexOf(model.provider) >= 0) {
      currentIdx = getAccountIndex(group, model.provider);
    } else {
      currentIdx = activeAccountIndices.get(group.providerName) || 0;
    }
    if (autoSwitchAttempts >= group.accounts.length) {
      ctx.ui.notify("Multi-account: all " + group.accounts.length + " accounts on " + group.providerLabel + " failed. Stopping auto-switch.", "error");
      autoSwitchAttempts = 0;
      return;
    }
    const nextIdx = (currentIdx + 1) % group.accounts.length;
    const ok = await switchToAccount(pi, ctx, group, nextIdx);
    lastAutoSwitchTime = now;
    if (!ok) return;
    activeAccountIndices.set(group.providerName, nextIdx);
    autoSwitchAttempts++;
    updateStatus(ctx, { provider: group.virtualProviderNames[nextIdx] });
    const failedLabel = group.accounts[currentIdx] ? group.accounts[currentIdx].label : ("Account " + (currentIdx + 1));
    const nextLabel = group.accounts[nextIdx] ? group.accounts[nextIdx].label : ("Account " + (nextIdx + 1));
    if (config.autoRetry === true && lastUserPrompt && !toolsUsedInTurn) {
      ctx.ui.notify("Multi-account: " + failedLabel + " failed (" + (msg.errorMessage || "error").slice(0, 80) + "). Switched to " + nextLabel + ", retrying...", "warning");
      pi.sendUserMessage(lastUserPrompt, { deliverAs: "followUp" });
    } else {
      ctx.ui.notify("Multi-account: " + failedLabel + " failed. Auto-switched to " + nextLabel + ". Resend your message to retry.", "warning");
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const group = findGroupByProvider(accountGroups, model.provider);
    if (!group || !group.sessionHeaders) return;
    const sessionId = ctx.sessionManager.getSessionId();
    for (const k of Object.keys(group.sessionHeaders)) {
      const v = group.sessionHeaders[k];
      event.headers[k] = v === "$sessionId" ? sessionId : v;
    }
  });

  pi.on("turn_start", async () => {
    if (accountGroups.size > 0 && activeAccountIndices.size > 0) {
      const activeAccounts: Record<string, number> = {};
      for (const entry of activeAccountIndices) {
        activeAccounts[entry[0]] = entry[1];
      }
      pi.appendEntry(STATE_ENTRY_TYPE, { activeAccounts });
    }
  });

  pi.on("session_shutdown", async () => {
    activeAccountIndices.clear();
  });

  pi.registerCommand("account", {
    description: "Manage multi-account providers (switch, cycle, list)",
    handler: async (args, ctx) => {
      if (accountGroups.size === 0) {
        ctx.ui.notify("No multi-account providers configured. Create " + getAgentDir() + "/multi-account.json", "info");
        return;
      }
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "" || cmd === "list") {
        const items: string[] = [];
        const map: Array<{ group: AccountGroup; index: number }> = [];
        for (const group of accountGroups.values()) {
          for (let i = 0; i < group.accounts.length; i++) {
            const cur = ctx.model;
            const isCur = cur ? cur.provider === group.virtualProviderNames[i] : false;
            const marker = isCur ? "\u25cf" : "\u25cb";
            items.push(marker + " " + group.providerLabel + " / " + group.accounts[i].label);
            map.push({ group, index: i });
          }
        }
        const sel = await ctx.ui.select("Select account:", items);
        if (!sel) return;
        const idx = items.indexOf(sel);
        if (idx < 0) return;
        const target = map[idx];
        const ok = await switchToAccount(pi, ctx, target.group, target.index);
        if (ok) {
          activeAccountIndices.set(target.group.providerName, target.index);
          ctx.ui.notify("Switched to " + target.group.accounts[target.index].label, "info");
          updateStatus(ctx, { provider: target.group.virtualProviderNames[target.index] });
        } else {
          ctx.ui.notify("Failed to switch", "error");
          updateStatus(ctx);
        }
        return;
      }
      if (cmd === "cycle") {
        await cycleToNextAccount(pi, ctx);
        return;
      }
      for (const group of accountGroups.values()) {
        const idx = group.accounts.findIndex(
          (a) => a.label.toLowerCase() === cmd || a.label.toLowerCase().indexOf(cmd) >= 0
        );
        if (idx >= 0) {
          const ok = await switchToAccount(pi, ctx, group, idx);
          if (ok) {
            activeAccountIndices.set(group.providerName, idx);
            ctx.ui.notify("Switched to " + group.accounts[idx].label, "info");
            updateStatus(ctx, { provider: group.virtualProviderNames[idx] });
          } else {
            ctx.ui.notify("Failed to switch", "error");
            updateStatus(ctx);
          }
          return;
        }
      }
      ctx.ui.notify('Account "' + cmd + '" not found', "error");
    },
  });

  pi.registerShortcut("alt+a" as never, {
    description: "Cycle multi-account provider",
    handler: async (ctx) => {
      if (accountGroups.size === 0) {
        ctx.ui.notify("No multi-account providers configured", "warning");
        return;
      }
      await cycleToNextAccount(pi, ctx);
    },
  });
}
