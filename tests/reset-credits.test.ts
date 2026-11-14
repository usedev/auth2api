import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { ClaudeResetService, ResetError } from "../src/usage/reset-credits";
import { AccountManager } from "../src/accounts/manager";
import { loadConfig } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { saveToken } from "../src/auth/token-storage";

const org = "11111111-1111-4111-8111-111111111111";
const grant = {
  id: "full_reset",
  label: "Full reset",
  resets_left: 1,
  clears: ["five_hour", "seven_day"],
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
};
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-test-"));
  fs.writeFileSync(path.join(dir, "config.yaml"), "api-keys: [test-key]\n");
  const config = loadConfig(path.join(dir, "config.yaml"));
  config["auth-dir"] = dir;
  for (const email of ["a@test.local", "b@test.local"])
    saveToken(dir, {
      provider: "anthropic",
      email,
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      accountUuid: "not-an-org",
      expiresAt: "2099-01-01T00:00:00Z",
    });
  const registry = buildRegistry(dir);
  registry.all().forEach((p) => p.manager.load());
  const manager = registry.get("anthropic").manager;
  const service = new ClaudeResetService(config, manager, dir);
  let b: any = {
    eligible: true,
    at_limit: false,
    next_grant_id: grant.id,
    grants: [
      { ...grant },
      {
        ...grant,
        id: "fable_reset",
        label: "Fable reset",
        resets_left: 2,
        clears: ["five_hour", "seven_day_overage_included"],
      },
    ],
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  let outcome: any = {
    result: "reset",
    cleared: ["five_hour", "seven_day", "secret"],
  };
  const fetcher: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const h = new Headers(init?.headers);
    assert.equal(h.get("authorization"), "Bearer fake-access");
    assert.equal(h.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(h.get("x-app"), "cli");
    assert.match(h.get("user-agent")!, /^claude-cli\/.+ \(external, cli\)$/);
    assert.equal(init?.redirect, "error");
    if (
      u ===
      "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
    ) {
      assert.equal(init?.method, "GET");
      return Response.json({ cedar_ember: b });
    }
    if (u === "https://api.anthropic.com/api/oauth/profile") {
      assert.equal(init?.method, "GET");
      return Response.json({ organization: { uuid: org } });
    }
    assert.equal(
      u,
      `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`,
    );
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.program, "cedar_ember");
    assert.equal(body.grant_id, "full_reset");
    assert.match(body.request_id, /^[a-f0-9]{64}$/);
    if (outcome instanceof Error) throw outcome;
    return Response.json(outcome);
  };
  return {
    dir,
    config,
    registry,
    manager,
    service,
    calls,
    fetcher,
    setBlock: (v: any) => (b = v),
    getBlock: () => b,
    setOutcome: (v: any) => (outcome = v),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("query is read-only, separates held and usable counts, hides grant IDs and gates cards", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const q = await f.service.query("a@test.local", "actor");
    assert.equal(q.heldCount, 3);
    assert.equal(q.availableCount, 1);
    assert.equal(q.credits[0].confirmationToken.length, 64);
    assert.equal(q.credits[1].confirmationToken, undefined);
    assert.equal(JSON.stringify(q).includes("full_reset"), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init?.method, "GET");
    for (const patch of [
      { paused: true },
      { ends_at: "2000-01-01T00:00:00Z" },
      { starts_at: "2099-01-01T00:00:00Z" },
      { ends_at: "bad" },
      { usable_now: false },
      { blocking: ["at_limit"] },
      { use_requires_limit: true },
    ]) {
      f.setBlock({ ...f.getBlock(), grants: [{ ...grant, ...patch }] });
      const result = await f.service.query("a@test.local", "actor");
      assert.equal(result.availableCount, 0);
      assert.ok(result.credits.every((c) => !c.confirmationToken));
    }
    f.setBlock(null);
    assert.equal((await f.service.query("a@test.local", "actor")).heldCount, 0);
    f.setBlock({ eligible: true });
    await assert.rejects(f.service.query("a@test.local", "actor"), ResetError);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("redemption binds confirmation, checks fresh grant, posts once and survives restart", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const before = f.manager.getSnapshots();
    const q = await f.service.query("a@test.local", "actor"),
      token = q.credits[0].confirmationToken;
    const stale = (await f.service.query("b@test.local", "actor")).credits[0]
      .confirmationToken;
    await assert.rejects(f.service.redeem("b@test.local", "actor", token));
    await assert.rejects(f.service.redeem("a@test.local", "other", token));
    const results = await Promise.allSettled([
      f.service.redeem("a@test.local", "actor", token),
      f.service.redeem("a@test.local", "actor", token),
    ]);
    assert.ok(
      results.some(
        (r) => r.status === "fulfilled" && r.value.outcome === "reset",
      ),
    );
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 1);
    const restarted = new ClaudeResetService(f.config, f.manager, f.dir);
    const replay = await restarted.redeem("a@test.local", "actor", token);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.cleared, ["five_hour", "seven_day"]);
    await assert.rejects(restarted.redeem("b@test.local", "actor", stale));
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 1);
    assert.deepEqual(f.manager.getSnapshots(), before);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("unknown POST outcome persists and blocks another confirmation across accounts and restart", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const token = (await f.service.query("a@test.local", "actor")).credits[0]
      .confirmationToken;
    f.setOutcome(new Error("secret upstream detail"));
    assert.equal(
      (await f.service.redeem("a@test.local", "actor", token)).outcome,
      "unknown",
    );
    const restart = new ClaudeResetService(f.config, f.manager, f.dir);
    assert.equal(
      (await restart.redeem("a@test.local", "actor", token)).replayed,
      true,
    );
    const other = (await restart.query("b@test.local", "actor")).credits[0]
      .confirmationToken;
    await assert.rejects(
      restart.redeem("b@test.local", "actor", other),
      (e: any) => e.code === "reset_locked",
    );
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 1);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("changed, expired, mismatched and unconfirmed requests do not POST", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const token = (await f.service.query("a@test.local", "actor")).credits[0]
      .confirmationToken;
    f.setBlock({ ...f.getBlock(), grants: [{ ...grant, resets_left: 2 }] });
    await assert.rejects(f.service.redeem("a@test.local", "actor", token));
    const file = path.join(f.dir, "reset-operations", token + ".json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.expires = 0;
    fs.writeFileSync(file, JSON.stringify(receipt));
    await assert.rejects(f.service.redeem("a@test.local", "actor", token));
    f.manager.getAccountForUsage("a@test.local")!.token.provider = "codex";
    const count = f.calls.length;
    await assert.rejects(f.service.query("a@test.local", "actor"));
    assert.equal(f.calls.length, count);
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 0);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("HTTP endpoints reject unauthenticated, cross-provider and invalid requests before upstream", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  const server = http.createServer(createServer(f.config, f.registry));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await original(base + "/admin/reset-credits")).status, 401);
    for (const query of [
      "",
      "?provider=codex&email=a%40test.local",
      "?provider=anthropic&email=a%40test.local&url=bad",
    ])
      assert.equal(
        (await original(base + "/admin/reset-credits" + query, { headers }))
          .status,
        400,
      );
    for (const body of [
      {},
      {
        provider: "anthropic",
        email: "a@test.local",
        confirm: false,
        confirmationToken: "a".repeat(64),
      },
      {
        provider: "anthropic",
        email: "a@test.local",
        confirm: true,
        confirmationToken: "a".repeat(64),
        grant_id: "bad",
      },
    ])
      assert.equal(
        (
          await original(base + "/admin/reset-credits/redeem", {
            headers,
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
    assert.equal(f.calls.length, 0);
    const r = await original(
      base + "/admin/reset-credits?provider=anthropic&email=a%40test.local",
      { headers },
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const q: any = await r.json();
    const redeemed = await original(base + "/admin/reset-credits/redeem", {
      headers,
      method: "POST",
      body: JSON.stringify({
        provider: "anthropic",
        email: "a@test.local",
        confirm: true,
        confirmationToken: q.credits[0].confirmationToken,
      }),
    });
    assert.equal(redeemed.status, 200);
    assert.equal(((await redeemed.json()) as any).outcome, "reset");
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.cleanup();
  }
});

test("storage failure and a process-crash marker fail closed before another POST", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const token = (await f.service.query("a@test.local", "actor")).credits[0]
      .confirmationToken;
    const file = path.join(f.dir, "reset-operations", token + ".json");
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    r.result = { outcome: "unknown" };
    fs.writeFileSync(file, JSON.stringify(r));
    const count = f.calls.length;
    assert.equal(
      (await f.service.redeem("a@test.local", "actor", token)).outcome,
      "unknown",
    );
    assert.equal(f.calls.length, count);
    fs.rmSync(path.join(f.dir, "reset-operations"), { recursive: true });
    fs.writeFileSync(path.join(f.dir, "reset-operations"), "not a directory");
    await assert.rejects(f.service.query("a@test.local", "actor"));
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 0);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("unrecognized upstream redemption response is unknown and never leaks its body", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = f.fetcher;
  try {
    const token = (await f.service.query("a@test.local", "actor")).credits[0]
      .confirmationToken;
    f.setOutcome({ result: "unexpected-secret", reason: "fake-access" });
    const result = await f.service.redeem("a@test.local", "actor", token);
    assert.deepEqual(result, { outcome: "unknown" });
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 1);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});

test("reset invalidation prevents an older in-flight usage response from repopulating cache", async () => {
  const { SubscriptionUsageService } = await import("../src/usage/service");
  const f = fixture(),
    original = globalThis.fetch;
  let resolveFirst!: (r: Response) => void,
    calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1)
      return new Promise<Response>((resolve) => (resolveFirst = resolve));
    return Response.json({ five_hour: { utilization: 0 } });
  };
  try {
    const usage = new SubscriptionUsageService(f.config);
    const before = usage.query(f.manager, "anthropic", "a@test.local");
    usage.invalidate("anthropic", "a@test.local");
    const after = await usage.query(f.manager, "anthropic", "a@test.local");
    assert.equal(after.windows[0].usedPercent, 0);
    resolveFirst(Response.json({ five_hour: { utilization: 100 } }));
    await before;
    const cached = await usage.query(f.manager, "anthropic", "a@test.local");
    assert.equal(cached.windows[0].usedPercent, 0);
    assert.equal(cached.cached, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    f.cleanup();
  }
});
