import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "./omp/omp-cli";
import { asNumber, isRecord } from "./type-guards";
import type {
  ProviderUsageReport,
  ProviderUsageSnapshot,
  ProviderUsageWindowId,
} from "./provider-usage-types";

const execFileAsync = promisify(execFile);
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 5 * 60_000;

type UsageQuery = { provider?: string; modelId?: string };
type CachedUsage = { expiresAt: number; snapshot: ProviderUsageSnapshot };

const usageCache = new Map<string, CachedUsage>();
const usageInFlight = new Map<string, Promise<ProviderUsageSnapshot>>();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d") {
    return windowId === "30d" ? "monthly" : windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

function accountLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  return nonEmptyString(metadata?.email) ?? nonEmptyString(metadata?.accountId);
}

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  limits: Array<{ id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> }>;
};

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  reportIndex: number,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}`;
    const priority = modelId ? (normalizedTier ? 1 : 0) : normalizedTier ? 3 : 2;
    const group = groups.get(groupKey);
    const candidate = { id: windowId, fraction, window };
    if (group) group.limits.push(candidate);
    else groups.set(groupKey, { priority, modelId, tier, limits: [candidate] });
  }

  const selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    const selected = selectedGroups.reduce((best, group) => group.priority < best.priority ? group : best);
    selectedGroups.splice(0, selectedGroups.length, selected);
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  const label = accountLabel(metadata);
  const plan = nonEmptyString(metadata?.planType);
  if (selectedGroups.length === 0) {
    return [{
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      noLimits: true,
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
    };
    for (const candidate of group.limits) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

export function parseProviderUsageOutput(output: string, query: UsageQuery = {}, now = Date.now()): ProviderUsageSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  const rawReports = Array.isArray(payload.reports) ? payload.reports : [];
  const reports = rawReports.flatMap((report, index) => isRecord(report) ? normalizeReport(report, query, now, index) : []);
  const generatedAt = asNumber(payload.generatedAt) ?? null;
  return { generatedAt, reports };
}

function usageCacheKey(query: UsageQuery): string {
  return `${query.provider ?? ""}\0${query.modelId ?? ""}`;
}

async function fetchProviderUsage(query: UsageQuery): Promise<ProviderUsageSnapshot> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  const args = ["usage", "--json", "--redact"];
  if (query.provider) args.push("--provider", query.provider);
  const { stdout } = await execFileAsync(bin, args, {
    timeout: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsHide: true,
  });
  return parseProviderUsageOutput(stdout, query);
}

export function getProviderUsage(query: UsageQuery = {}): Promise<ProviderUsageSnapshot> {
  const key = usageCacheKey(query);
  const now = Date.now();
  const cached = usageCache.get(key);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.snapshot);
  const running = usageInFlight.get(key);
  if (running) return running;
  const request = fetchProviderUsage(query)
    .then((snapshot) => {
      usageCache.set(key, { snapshot, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
      return snapshot;
    })
    .finally(() => usageInFlight.delete(key));
  usageInFlight.set(key, request);
  return request;
}

export function clearProviderUsageCache(): void {
  usageCache.clear();
}
