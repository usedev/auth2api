import { createHash } from "node:crypto";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config } from "../config";
import { ProviderId } from "../auth/types";
import { upstreamFetch } from "../utils/proxy";

export interface UsageWindow {
  name: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetsAt: string | null;
  displayName?: string;
  allowancePercentOfWeekly?: number;
  usedPercentOfWeekly?: number;
}
export interface SubscriptionUsage {
  provider: ProviderId;
  email: string;
  supported: boolean;
  fetchedAt: string;
  cached: boolean;
  planType: string | null;
  windows: UsageWindow[];
  credits?: {
    hasCredits: boolean | null;
    unlimited: boolean | null;
    balance: string | null;
  };
  error?: { code: string; message: string; status?: number };
}
const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const boolean = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;
function iso(value: unknown): string | null {
  const ms =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
    ? new Date(ms).toISOString()
    : null;
}

export function parseUsage(
  provider: ProviderId,
  data: any,
  now = Date.now(),
): UsageWindow[] {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid usage response");
  const windows: UsageWindow[] = [];
  function add(
    name: string,
    value: any,
    seconds: number | null,
    codex: boolean,
  ) {
    if (!value || typeof value !== "object") return;
    const used = number(codex ? value.used_percent : value.utilization);
    const after = number(value.reset_after_seconds);
    windows.push({
      name,
      usedPercent: used,
      remainingPercent:
        used === null ? null : Math.max(0, Math.min(100, 100 - used)),
      windowSeconds: seconds,
      resetsAt: codex
        ? (iso(value.reset_at) ??
          (after === null ? null : iso(now / 1000 + after)))
        : iso(value.resets_at),
    });
  }
  if (provider === "codex") {
    const addLimit = (prefix: string, limit: any) => {
      for (const slot of ["primary_window", "secondary_window"]) {
        const w = limit?.[slot];
        const seconds = number(w?.limit_window_seconds);
        const name =
          seconds === 18000
            ? "five_hour"
            : seconds === 604800
              ? "seven_day"
              : slot;
        add(prefix + name, w, seconds, true);
      }
    };
    addLimit("", data.rate_limit);
    if (Array.isArray(data.additional_rate_limits)) {
      for (const limit of data.additional_rate_limits) {
        if (typeof limit?.metered_feature === "string")
          addLimit(limit.metered_feature + ":", limit.rate_limit);
      }
    }
  } else {
    for (const name of [
      "five_hour",
      "seven_day",
      "seven_day_sonnet",
      "seven_day_opus",
      "seven_day_oauth_apps",
      "seven_day_overage_included",
    ]) {
      add(name, data[name], name === "five_hour" ? 18000 : 604800, false);
    }
    // New responses expose model-specific limits only in limits[]. Keep the
    // legacy windows as fallback and merge known equivalents without duplicates.
    if (Array.isArray(data.limits)) {
      data.limits.forEach((limit: any, index: number) => {
        if (!limit || typeof limit !== "object") return;
        const model = limit.scope?.model;
        const displayName =
          typeof model?.display_name === "string"
            ? model.display_name.trim()
            : "";
        const legacyNames: Record<string, string> = {
          fable: "seven_day_overage_included",
          sonnet: "seven_day_sonnet",
          opus: "seven_day_opus",
        };
        let name: string;
        if (limit.kind === "session") name = "five_hour";
        else if (limit.kind === "weekly_all") name = "seven_day";
        else if (limit.kind === "weekly_scoped") {
          // Surface-scoped limits must not overwrite a model-only window.
          name =
            !limit.scope?.surface &&
            Object.hasOwn(legacyNames, displayName.toLowerCase())
              ? legacyNames[displayName.toLowerCase()]
              : `weekly_scoped_${index}`;
        } else return;
        const existing = windows.find((w) => w.name === name);
        const used = number(limit.percent) ?? existing?.usedPercent ?? null;
        const window: UsageWindow = {
          name,
          usedPercent: used,
          remainingPercent:
            used === null ? null : Math.max(0, Math.min(100, 100 - used)),
          windowSeconds: name === "five_hour" ? 18000 : 604800,
          resetsAt: iso(limit.resets_at) ?? existing?.resetsAt ?? null,
        };
        if (displayName) window.displayName = displayName;
        if (
          limit.kind === "weekly_scoped" &&
          Array.isArray(data.weekly_scoped_shares)
        ) {
          const share = data.weekly_scoped_shares.find(
            (s: any) => s && s.limit_index === index,
          );
          const allowance = number(share?.allowance_percent_of_weekly);
          const weeklyUsed = number(share?.used_percent_of_weekly);
          if (allowance !== null) window.allowancePercentOfWeekly = allowance;
          if (weeklyUsed !== null) window.usedPercentOfWeekly = weeklyUsed;
        }
        // is_active is not an availability flag: normal session/weekly windows
        // can have is_active=false while still carrying valid usage.
        if (existing) Object.assign(existing, window);
        else windows.push(window);
      });
    }
  }
  return windows;
}

/** Per-server cache; credentials are hashed and never included in API responses. */
export class SubscriptionUsageService {
  private cache = new Map<
    string,
    { key: string; expires: number; value: SubscriptionUsage }
  >();
  private pending = new Map<string, Promise<SubscriptionUsage>>();
  constructor(private config: Config) {}

  async query(
    manager: AccountManager,
    provider: ProviderId,
    email: string,
    force = false,
  ): Promise<SubscriptionUsage> {
    const account = manager.getAccountForUsage(email);
    const base: SubscriptionUsage = {
      provider,
      email,
      supported: provider === "codex" || provider === "anthropic",
      fetchedAt: new Date().toISOString(),
      cached: false,
      planType: account?.token.planType ?? null,
      windows: [],
    };
    if (
      manager.provider !== provider ||
      (account &&
        (account.provider !== provider ||
          (account.token.provider ?? "anthropic") !== provider))
    ) {
      return {
        ...base,
        error: {
          code: "provider_mismatch",
          message: "Requested provider does not match account credentials",
        },
      };
    }
    if (!base.supported)
      return {
        ...base,
        error: {
          code: "unsupported",
          message: "Subscription usage is not supported for this provider",
        },
      };
    if (!account)
      return {
        ...base,
        error: {
          code: "account_not_found",
          message: "Account no longer exists",
        },
      };
    const identity = JSON.stringify([provider, email]);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          identity,
          account.token.accessToken,
          account.accountUuid,
        ]),
      )
      .digest("hex");
    const hit = this.cache.get(identity);
    if (!force && hit?.key === key && hit.expires > Date.now())
      return { ...hit.value, cached: true };
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.fetch(account, base)
      .then((value) => {
        this.cache.set(identity, {
          key,
          expires: Date.now() + (value.error ? 15000 : 60000),
          value,
        });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async fetch(
    account: AvailableAccount,
    base: SubscriptionUsage,
  ): Promise<SubscriptionUsage> {
    try {
      const response = await this.request(account);
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        return {
          ...base,
          error: {
            code:
              status === 401
                ? "unauthenticated"
                : status === 403
                  ? "forbidden"
                  : status === 429
                    ? "rate_limited"
                    : "upstream_error",
            message: `Usage endpoint returned HTTP ${status}`,
            status,
          },
        };
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return {
          ...base,
          error: {
            code: "invalid_response",
            message: "Usage endpoint returned invalid JSON",
          },
        };
      }
      let windows: UsageWindow[];
      try {
        windows = parseUsage(base.provider, data);
      } catch {
        return {
          ...base,
          error: {
            code: "invalid_response",
            message: "Usage endpoint returned an invalid payload",
          },
        };
      }
      const value: SubscriptionUsage = {
        ...base,
        fetchedAt: new Date().toISOString(),
        windows,
        planType:
          typeof data.plan_type === "string" ? data.plan_type : base.planType,
      };
      if (
        base.provider === "codex" &&
        data.credits &&
        typeof data.credits === "object"
      )
        value.credits = {
          hasCredits: boolean(data.credits.has_credits),
          unlimited: boolean(data.credits.unlimited),
          balance:
            typeof data.credits.balance === "string"
              ? data.credits.balance
              : null,
        };
      return value;
    } catch {
      // Do not expose upstream error bodies, URLs or credentials.
      return {
        ...base,
        error: {
          code: "network_error",
          message: "Usage request failed or timed out",
        },
      };
    }
  }

  private request(account: AvailableAccount): Promise<Response> {
    // Construct an allowlisted request from stored credentials only. Never
    // forward client headers, query parameters, cookies or a caller-supplied URL.
    // Keep this separate from generation and reset-credit/consume endpoints.
    const codex = account.provider === "codex";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.token.accessToken}`,
      Accept: "application/json",
    };
    if (codex) {
      headers["OpenAI-Beta"] = "codex-1";
      headers.originator = "Codex Desktop";
      if (account.chatgptAccountId)
        headers["ChatGPT-Account-ID"] = account.chatgptAccountId;
    } else {
      headers["anthropic-beta"] = "oauth-2025-04-20";
      headers["User-Agent"] =
        `claude-code/${this.config.cloaking["cli-version"] || "2.1.88"}`;
    }
    return upstreamFetch(
      codex
        ? "https://chatgpt.com/backend-api/wham/usage"
        : "https://api.anthropic.com/api/oauth/usage",
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
    );
  }
}
