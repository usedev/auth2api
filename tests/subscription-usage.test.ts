import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import vm from "node:vm";
import { saveToken } from "../src/auth/token-storage";
import { loadConfig } from "../src/config";
import { buildRegistry } from "../src/providers/registry";
import { createServer } from "../src/server";
import { parseUsage, SubscriptionUsageService } from "../src/usage/service";

const codexPayload = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18000,
      reset_at: 1800000000,
    },
    secondary_window: {
      used_percent: 80,
      limit_window_seconds: 604800,
      reset_after_seconds: 3600,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: "12.34" },
  secret: "must-not-leak",
};

test("quota windows use upstream durations, retain unknowns and normalize reset times", () => {
  const windows = parseUsage("codex", codexPayload, 1700000000000);
  assert.equal(windows[0].name, "five_hour");
  assert.equal(windows[0].remainingPercent, 75);
  assert.equal(windows[0].resetsAt, new Date(1800000000000).toISOString());
  assert.equal(windows[1].name, "seven_day");
  assert.equal(windows[1].resetsAt, new Date(1700003600000).toISOString());
  assert.deepEqual(
    parseUsage("codex", {
      rate_limit: { primary_window: null, secondary_window: null },
    }),
    [],
  );
  const custom = parseUsage("codex", {
    rate_limit: {
      primary_window: { limit_window_seconds: 604800, used_percent: 0 },
    },
    additional_rate_limits: [
      {
        metered_feature: "spark",
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 18000 },
        },
      },
    ],
  });
  assert.equal(custom[0].name, "seven_day");
  assert.equal(custom[0].remainingPercent, 100);
  assert.equal(custom[1].name, "spark:five_hour");
  assert.equal(custom[1].remainingPercent, 0);
  const claude = parseUsage("anthropic", {
    five_hour: { utilization: 50, resets_at: "2026-11-14T00:00:00Z" },
    seven_day: { utilization: null, resets_at: null },
  });
  assert.equal(claude[0].remainingPercent, 50);
  assert.equal(claude[0].resetsAt, "2026-11-14T00:00:00.000Z");
  assert.equal(claude[1].remainingPercent, null);
  assert.equal(claude[1].resetsAt, null);
  assert.throws(() => parseUsage("codex", null));
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-quota-"));
  for (const provider of ["codex", "anthropic", "cursor"] as const)
    saveToken(dir, {
      provider,
      email: `${provider}@test.local`,
      accessToken: `${provider}-secret`,
      refreshToken: "refresh-secret",
      accountUuid: `${provider}-account`,
      expiresAt: "2099-01-01T00:00:00Z",
    });
  fs.writeFileSync(path.join(dir, "config.yaml"), "api-keys: [test-key]\n");
  const config = loadConfig(path.join(dir, "config.yaml"));
  config["auth-dir"] = dir;
  config["api-keys"] = new Set(["test-key"]);
  const registry = buildRegistry(dir);
  registry.all().forEach((p) => p.manager.load());
  return { dir, config, registry };
}

test("query caches and deduplicates, invalidates changed credentials, and never alters account state", async () => {
  const { dir, config, registry } = fixture();
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      const h = new Headers(init?.headers);
      assert.equal(h.get("ChatGPT-Account-ID"), "codex-account");
      assert.equal(h.get("OpenAI-Beta"), "codex-1");
      assert.equal(h.get("originator"), "Codex Desktop");
      assert.deepEqual([...h.keys()].sort(), [
        "accept",
        "authorization",
        "chatgpt-account-id",
        "openai-beta",
        "originator",
      ]);
      assert.match(
        h.get("authorization")!,
        /^Bearer (codex-secret|rotated-secret)$/,
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return Response.json(codexPayload);
    };
    const manager = registry.get("codex").manager;
    manager.recordFailure(
      "codex@test.local",
      "rate_limit",
      "existing cooldown",
    );
    const before = manager.getSnapshots();
    const service = new SubscriptionUsageService(config);
    const query = (force = false) =>
      service.query(manager, "codex", "codex@test.local", force);
    const [a, b] = await Promise.all([query(), query()]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.equal(a.credits?.balance, "12.34");
    assert.equal(JSON.stringify(a).includes("secret"), false);
    assert.equal((await query()).cached, true);
    await query(true);
    assert.equal(calls, 2);
    const account = manager.getAccountForUsage("codex@test.local")!;
    account.token.accessToken = "rotated-secret";
    await query();
    assert.equal(calls, 3);
    assert.deepEqual(manager.getSnapshots(), before);
    for (const status of [401, 403, 429, 500]) {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return new Response("secret upstream body", { status });
      };
      const error = await query(true);
      assert.equal(attempts, 1);
      assert.equal(error.error?.status, status);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      assert.deepEqual(manager.getSnapshots(), before);
    }
    globalThis.fetch = async () => {
      throw new Error("secret token");
    };
    assert.equal((await query(true)).error?.code, "network_error");
    globalThis.fetch = async () => new Response("<html>not json</html>");
    assert.equal((await query(true)).error?.code, "invalid_response");
    globalThis.fetch = async () => Response.json(null);
    assert.equal((await query(true)).error?.code, "invalid_response");
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admin usage requires auth, validates filters, isolates failures and handles unsupported providers", async () => {
  const { dir, config, registry } = fixture();
  const original = globalThis.fetch;
  const server = http.createServer(createServer(config, registry));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/usage`;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (String(url).includes("anthropic")) {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      const h = new Headers(init?.headers);
      assert.deepEqual([...h.keys()].sort(), [
        "accept",
        "anthropic-beta",
        "authorization",
        "user-agent",
      ]);
      assert.equal(h.get("authorization"), "Bearer anthropic-secret");
      assert.equal(
        h.get("user-agent"),
        `claude-code/${config.cloaking["cli-version"] || "2.1.88"}`,
      );
      assert.equal(
        new Headers(init?.headers).get("anthropic-beta"),
        "oauth-2025-04-20",
      );
      return new Response("secret", { status: 403 });
    }
    return Response.json(codexPayload);
  };
  try {
    assert.equal((await original(url)).status, 401);
    assert.equal(calls, 0);
    const headers = { Authorization: "Bearer test-key" };
    for (const query of [
      "?provider=invalid",
      "?provider[]=codex",
      "?refresh=1",
      "?email[]=a",
      "?email=",
      "?email=%20",
      "?provider=codex&provider=anthropic",
      "?provider=codex&email=anthropic%40test.local",
      "?provider=anthropic&email=codex%40test.local",
      "?url=https%3A%2F%2Fexample.com&reset=true",
    ]) {
      assert.equal((await original(url + query, { headers })).status, 400);
    }
    assert.equal(
      (await original(url + "?email=missing", { headers })).status,
      404,
    );
    assert.equal(calls, 0);
    const response = await original(url, {
      headers: {
        ...headers,
        Cookie: "client-secret",
        "ChatGPT-Account-ID": "client-controlled",
        "OpenAI-Beta": "client-controlled",
      },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = (await response.json()) as any;
    assert.equal(data.accounts.length, 3);
    assert.equal(
      data.accounts.find((a: any) => a.provider === "codex").windows[0]
        .remainingPercent,
      75,
    );
    assert.equal(
      data.accounts.find((a: any) => a.provider === "anthropic").error.code,
      "forbidden",
    );
    assert.equal(
      data.accounts.find((a: any) => a.provider === "cursor").supported,
      false,
    );
    assert.equal(calls, 2);
    const filtered = (await (
      await original(url + "?provider=codex", { headers })
    ).json()) as any;
    assert.equal(filtered.accounts.length, 1);
    assert.equal(filtered.accounts[0].cached, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cc-switch extractor presents each window as percent and never fabricates missing quota", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../examples/cc-switch-usage.js"),
    "utf8",
  );
  for (const baseUrl of [
    "http://localhost:8317",
    "http://localhost:8317/v1",
    "http://localhost:8317/v1/",
  ]) {
    const script = vm.runInNewContext(
      source.replace("{{baseUrl}}", baseUrl).replace("{{apiKey}}", "test-key"),
    );
    assert.equal(
      script.request.url,
      "http://localhost:8317/admin/usage?provider=anthropic",
    );
    const results = script.extractor({
      accounts: [
        {
          provider: "codex",
          email: "a",
          supported: true,
          fetchedAt: "2026-11-13T08:16:47.151Z",
          windows: parseUsage("codex", codexPayload),
        },
        {
          provider: "codex",
          email: "b",
          supported: true,
          error: { message: "forbidden" },
        },
      ],
    });
    assert.equal(results.length, 3);
    assert.equal(results[0].remaining, 75);
    assert.equal(results[0].unit, "%");
    assert.equal(results[0].total, 100);
    assert.equal(results[0].planName, "5 小时 #1");
    assert.match(results[0].extra, /更新 16:16/);
    const dated = script.extractor({
      accounts: [
        {
          provider: "anthropic",
          email: "a",
          supported: true,
          fetchedAt: "bad",
          windows: [
            {
              name: "five_hour",
              remainingPercent: 75,
              usedPercent: 25,
              resetsAt: "2026-11-13T23:30:00.002Z",
            },
          ],
        },
      ],
    });
    assert.match(dated[0].extra, /11-14 07:30 北京/);
    assert.match(dated[0].extra, /更新 未知/);
    assert.equal(results[2].isValid, false);
    assert.equal(results[2].remaining, undefined);
    assert.equal(script.extractor({ accounts: [] }).isValid, false);
    assert.equal(script.extractor({ error: "bad" }).isValid, false);
    const missing = script.extractor({
      accounts: [
        {
          provider: "codex",
          email: "a",
          supported: true,
          windows: [{ name: "five_hour", remainingPercent: null }],
        },
      ],
    });
    assert.equal(missing[0].isValid, false);
    assert.equal(missing[0].remaining, undefined);
  }
});

test("provider mismatch is rejected before cache lookup or any upstream request", async () => {
  const { dir, config, registry } = fixture();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(codexPayload);
  };
  try {
    const service = new SubscriptionUsageService(config);
    for (const [requested, actual] of [
      ["codex", "anthropic"],
      ["anthropic", "codex"],
    ] as const) {
      const result = await service.query(
        registry.get(actual).manager,
        requested,
        `${actual}@test.local`,
      );
      assert.equal(result.error?.code, "provider_mismatch");
    }
    assert.equal(calls, 0);
    const manager = registry.get("codex").manager;
    await service.query(manager, "codex", "codex@test.local");
    assert.equal(calls, 1);
    manager.getAccountForUsage("codex@test.local")!.token.provider =
      "anthropic";
    const result = await service.query(manager, "codex", "codex@test.local");
    assert.equal(result.error?.code, "provider_mismatch");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cc-switch details show countdowns, plans and credits without inventing reset or balance", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../examples/cc-switch-usage.js"),
    "utf8",
  );
  class FixedDate extends Date {
    static now() {
      return Date.parse("2026-11-13T08:30:00Z");
    }
  }
  const script = vm.runInNewContext(
    source.replace("var showDetails = false", "var showDetails = true"),
    { Date: FixedDate },
  );
  const account = {
    provider: "anthropic",
    email: "a@test.local",
    supported: true,
    cached: true,
    fetchedAt: "2026-11-13T08:29:00Z",
    planType: "pro",
    windows: [
      {
        name: "five_hour",
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "2026-11-13T11:30:00Z",
      },
    ],
  };
  const show = (overrides: any = {}) =>
    script.extractor({ accounts: [{ ...account, ...overrides }] })[0];
  const result = show();
  assert.match(result.planName, /^5 小时/);
  assert.match(result.extra, /已用 25.00%/);
  assert.match(result.extra, /剩余 75.00%/);
  assert.match(result.extra, /3 小时 后重置（查询时估算）/);
  assert.match(result.extra, /2026-11-13 19:30:00（北京时间）/);
  assert.match(result.extra, /账号: anthropic \/ a@test.local/);
  assert.match(result.extra, /订阅: pro/);
  assert.match(result.extra, /（缓存）/);
  assert.doesNotMatch(result.extra, /积分/);
  assert.match(show({ credits: { balance: "0.00" } }).extra, /积分余额: 0.00/);
  assert.match(
    show({ credits: { unlimited: true, balance: null } }).extra,
    /积分: 不限量/,
  );
  for (const reset of ["2026-11-13T08:30:00Z", "2026-11-12T08:30:00Z"]) {
    const old = show({ windows: [{ ...account.windows[0], resetsAt: reset }] });
    assert.match(old.extra, /已到重置时间，请刷新确认/);
    assert.equal(old.remaining, 75);
  }
  assert.match(
    show({ windows: [{ ...account.windows[0], resetsAt: null }] }).extra,
    /重置倒计时未知/,
  );
  assert.match(
    show({
      windows: [{ ...account.windows[0], resetsAt: "2026-11-14T10:31:00Z" }],
    }).extra,
    /1 天 2 小时 1 分钟后重置/,
  );
});

test("cc-switch compact layout keeps each line short and omits repeated account and quota text", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../examples/cc-switch-usage.js"),
    "utf8",
  );
  class FixedDate extends Date {
    static now() {
      return Date.parse("2026-11-13T08:25:00Z");
    }
  }
  const script = vm.runInNewContext(source, { Date: FixedDate });
  const row = script.extractor({
    accounts: [
      {
        provider: "anthropic",
        email: "long-email@example.com",
        supported: true,
        cached: true,
        fetchedAt: "2026-11-13T08:25:00Z",
        windows: [
          {
            name: "five_hour",
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: "2026-11-13T11:30:00Z",
          },
        ],
      },
    ],
  })[0];
  assert.equal(row.planName, "5 小时");
  assert.equal(
    row.extra,
    "已用 25.00% · 3时5分后重置 · 11-13 19:30 北京 · 更新 16:25 缓存",
  );
  assert.ok(row.extra.length < 70);
  assert.doesNotMatch(row.extra, /example.com|剩余|2026/);
});
