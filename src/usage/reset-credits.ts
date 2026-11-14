import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config } from "../config";
import { upstreamFetch } from "../utils/proxy";

const ORIGIN = "https://api.anthropic.com";
const USAGE = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const WINDOWS = new Set([
  "five_hour",
  "seven_day",
  "seven_day_overage_included",
]);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
const date = (v: unknown): number | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? Date.parse(v)
    : null;
export class ResetError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new ResetError(status, code, message);
}
interface Outcome {
  outcome: string;
  cleared?: string[];
  replayed?: boolean;
}
interface Receipt {
  email: string;
  actor: string;
  credential: string;
  grant: string;
  snapshot: string;
  created: number;
  expires: number;
  result?: Outcome;
}
function validGrant(g: any, now: number): boolean {
  return (
    !!g &&
    typeof g.id === "string" &&
    /^[a-z0-9_-]{1,40}$/.test(g.id) &&
    Number.isSafeInteger(g.resets_left) &&
    g.resets_left > 0 &&
    g.paused !== true &&
    Array.isArray(g.clears) &&
    g.clears.length > 0 &&
    g.clears.every((x: unknown) => typeof x === "string") &&
    (g.starts_at == null ||
      (date(g.starts_at) !== null && date(g.starts_at)! <= now)) &&
    (g.ends_at == null || (date(g.ends_at) !== null && date(g.ends_at)! > now))
  );
}
function redeemable(b: any, g: any, now: number): boolean {
  return (
    validGrant(g, now) &&
    b.eligible === true &&
    g.id === b.next_grant_id &&
    g.usable_now === true &&
    (g.use_requires_limit === false || b.at_limit === true) &&
    (g.blocking == null ||
      (Array.isArray(g.blocking) && g.blocking.length === 0)) &&
    (b.cooldown_until == null ||
      (date(b.cooldown_until) !== null && date(b.cooldown_until)! <= now))
  );
}
function snapshot(g: any): string {
  return hash(
    JSON.stringify([
      g.id,
      g.label,
      g.resets_left,
      g.clears,
      g.starts_at,
      g.ends_at,
      g.use_requires_limit,
    ]),
  );
}

/** No timers, token refresh or automatic redemption. All writes use a private
 * durable receipt directory shared by processes using the same auth directory. */
export class ClaudeResetService {
  private directory: string;
  constructor(
    private config: Config,
    private manager: AccountManager,
    authDir: string,
  ) {
    this.directory = path.join(authDir, "reset-operations");
  }
  private account(email: string): AvailableAccount {
    if (this.manager.provider !== "anthropic")
      fail(400, "provider_mismatch", "Claude OAuth account required");
    const a = this.manager.getAccountForUsage(email);
    if (!a) fail(404, "account_not_found", "Claude account not found");
    if (
      a.provider !== "anthropic" ||
      (a.token.provider ?? "anthropic") !== "anthropic"
    )
      fail(400, "provider_mismatch", "Claude OAuth account required");
    if (!a.token.accessToken)
      fail(400, "missing_token", "OAuth access token required");
    return a;
  }
  private credential(a: AvailableAccount): string {
    return hash(JSON.stringify([a.token.accessToken, a.accountUuid]));
  }
  private init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private save(file: string, data: unknown) {
    const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    const dir = fs.openSync(this.directory, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
  private async request(
    a: AvailableAccount,
    endpoint: string,
    body?: object,
  ): Promise<any> {
    let r: Response;
    try {
      r = await upstreamFetch(ORIGIN + endpoint, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          Authorization: `Bearer ${a.token.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "x-app": "cli",
          "User-Agent": `claude-cli/${this.config.cloaking["cli-version"] || "2.1.88"} (external, cli)`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(
        502,
        "upstream_unavailable",
        "Reset service request failed or timed out",
      );
    }
    if (!r.ok) {
      await r.body?.cancel();
      fail(502, "upstream_error", `Reset service returned HTTP ${r.status}`);
    }
    // Bound response size, including servers without Content-Length.
    const reader = r.body?.getReader();
    if (!reader) fail(502, "invalid_response", "Empty reset response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          fail(502, "invalid_response", "Reset response too large");
        }
        chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.error
      )
        throw new Error();
      return data;
    } catch (e) {
      if (e instanceof ResetError) throw e;
      fail(502, "invalid_response", "Invalid reset service response");
    }
  }
  private async block(a: AvailableAccount): Promise<any> {
    const data = await this.request(a, USAGE);
    const b = data.cedar_ember;
    if (b == null) return null;
    if (
      typeof b !== "object" ||
      !Array.isArray(b.grants) ||
      typeof b.eligible !== "boolean"
    )
      fail(502, "invalid_response", "Invalid reset grants");
    return b;
  }
  async query(email: string, actor: string) {
    const a = this.account(email),
      b = await this.block(a),
      now = Date.now();
    const credits: any[] = [];
    if (b)
      for (const g of b.grants) {
        if (!validGrant(g, now)) continue;
        const canRedeem = redeemable(b, g, now);
        const credit: any = {
          label: typeof g.label === "string" ? g.label : "Reset",
          resetsLeft: g.resets_left,
          startsAt: g.starts_at ?? null,
          expiresAt: g.ends_at ?? null,
          clears: strings(g.clears),
          useRequiresLimit: g.use_requires_limit !== false,
          redeemable: canRedeem,
        };
        if (canRedeem) {
          this.init();
          const confirmation = randomBytes(32).toString("hex");
          this.save(path.join(this.directory, confirmation + ".json"), {
            email,
            actor,
            credential: this.credential(a),
            grant: g.id,
            snapshot: snapshot(g),
            created: now,
            expires: now + 5 * 60000,
          } satisfies Receipt);
          credit.confirmationToken = confirmation;
          credit.confirmationExpiresAt = new Date(
            now + 5 * 60000,
          ).toISOString();
        }
        credits.push(credit);
      }
    return {
      provider: "anthropic",
      email,
      eligible: b?.eligible === true,
      heldCount: credits.reduce((n, g) => n + g.resetsLeft, 0),
      availableCount: credits
        .filter((g) => g.redeemable)
        .reduce((n, g) => n + g.resetsLeft, 0),
      credits,
      fetchedAt: new Date(now).toISOString(),
    };
  }
  async redeem(email: string, actor: string, token: string): Promise<Outcome> {
    const a = this.account(email);
    if (!/^[a-f0-9]{64}$/.test(token))
      fail(400, "invalid_confirmation", "Invalid confirmation token");
    const file = path.join(this.directory, token + ".json");
    let receipt: Receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail(409, "invalid_confirmation", "Query credits for a new confirmation");
    }
    if (receipt.email !== email || receipt.actor !== actor)
      fail(
        409,
        "confirmation_mismatch",
        "Confirmation does not match account or API key",
      );
    if (receipt.result) return { ...receipt.result, replayed: true };
    if (
      receipt.expires <= Date.now() ||
      receipt.credential !== this.credential(a)
    )
      fail(409, "stale_confirmation", "Query credits again before confirming");
    const profile = await this.request(a, "/api/oauth/profile");
    const org = profile.organization?.uuid;
    if (
      typeof org !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(org) ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(org)
    )
      fail(502, "invalid_organization", "OAuth organization unavailable");
    const orgKey = hash(org.toLowerCase()),
      lock = path.join(this.directory, orgKey + ".lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      fail(
        409,
        "reset_locked",
        "Another reset is running or its outcome requires reconciliation",
      );
    }
    let release = true;
    try {
      // Re-read under the organization lock: another request may have completed.
      receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (receipt.result) return { ...receipt.result, replayed: true };
      const fence = path.join(this.directory, orgKey + ".fence");
      if (fs.existsSync(fence)) {
        const last = JSON.parse(fs.readFileSync(fence, "utf8"));
        if (typeof last.at !== "number" || receipt.created <= last.at)
          fail(
            409,
            "stale_confirmation",
            "Query credits after the previous reset",
          );
      }
      const b = await this.block(a);
      const g = b?.grants.find((g: any) => g?.id === receipt.grant);
      if (
        receipt.expires <= Date.now() ||
        !g ||
        !redeemable(b, g, Date.now()) ||
        snapshot(g) !== receipt.snapshot
      )
        fail(
          409,
          "not_redeemable",
          "Confirmed credit changed or is no longer redeemable",
        );
      receipt.result = { outcome: "unknown" };
      // Persist before POST. A crash/timeout leaves a durable organization lock;
      // neither this confirmation nor a new one can silently consume another card.
      this.save(file, receipt);
      this.save(fence, { at: Date.now() });
      release = false;
      let outcome: Outcome = { outcome: "unknown" };
      try {
        const result = await this.request(
          a,
          `/api/organizations/${org}/reset_rate_limits`,
          {
            program: "cedar_ember",
            grant_id: receipt.grant,
            request_id: token,
          },
        );
        if (
          !["stamp_indeterminate", "reset_unconfirmed"].includes(
            result.reason,
          ) &&
          [
            "reset",
            "already_used",
            "not_limited",
            "cooldown",
            "ineligible",
          ].includes(result.result)
        ) {
          outcome = {
            outcome: result.result,
            cleared: strings(result.cleared).filter((w) => WINDOWS.has(w)),
          };
        }
      } catch {
        /* An unconfirmed POST must never be retried automatically. */
      }
      receipt.result = outcome;
      this.save(file, receipt);
      release = outcome.outcome !== "unknown";
      return outcome;
    } finally {
      if (release) fs.rmdirSync(lock);
    }
  }
}
