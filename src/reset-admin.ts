/** Isolated administrative listener. Does not start generation handlers,
 * OAuth refresh jobs, stats writers or account timers. */
import express from "express";
import { loadConfig, resolveAuthDir } from "./config";
import { buildRegistry } from "./providers/registry";
import { configureProxy } from "./utils/proxy";
import { createServer } from "./server";

const config = loadConfig(
  process.argv.find((a) => a.startsWith("--config="))?.slice(9),
);
configureProxy(config["proxy-url"]);
const registry = buildRegistry(resolveAuthDir(config["auth-dir"]));
for (const provider of registry.all()) provider.manager.load();
const app = express();
const permitted = new Set([
  "GET /health",
  "GET /admin/usage",
  "GET /admin/reset-credits",
  "POST /admin/reset-credits/redeem",
  "POST /admin/reset-credits/redeem-next",
]);
app.use(async (req, res, next) => {
  if (!permitted.has(`${req.method} ${req.path}`)) {
    res.sendStatus(404);
    return;
  }
  try {
    // Reload reads current credentials from the read-only production volume,
    // without refreshing them or writing to the production account files.
    if (req.path !== "/health")
      await registry.get("anthropic").manager.reload();
    next();
  } catch {
    res.status(503).json({ error: { message: "Account reload unavailable" } });
  }
});
app.use(
  createServer(
    config,
    registry,
    undefined,
    process.env.RESET_STATE_DIR || "/state",
  ),
);
const port = Number(process.env.ADMIN_PORT || 8318);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid ADMIN_PORT");
const server = app.listen(port, "0.0.0.0", () =>
  console.log(
    `Reset administration listening on ${port}; background OAuth refresh disabled`,
  ),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
