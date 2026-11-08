// pnpm dev: builds site/ into services/api/public, applies D1 migrations to the
// local database, then runs `wrangler dev` (API + site on :8787) and Vite (web
// app with hot reload on :5173, /v1 proxied to :8787). Ctrl-C stops both.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ORIGIN = "http://localhost:5173";

function runOnce(label, args, env = {}) {
  console.info(`dev: ${label}`);
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`dev: ${label} failed (exit ${result.status ?? result.signal})`);
    process.exit(result.status ?? 1);
  }
}

runOnce("building site", ["--filter", "@porchlight/site", "build"]);
// CI=1 answers wrangler's "Ok to proceed?" prompt.
runOnce("applying local D1 migrations", ["--filter", "@porchlight/api", "db:migrate:local"], { CI: "1" });

// APP_ORIGIN must equal the browser's Origin, or the API rejects cookie writes with 403.
// EMAIL_DEV_LOG prints sign-in links in this output when .dev.vars has no RESEND_API_KEY.
const children = [
  spawn("pnpm", ["exec", "wrangler", "dev", "--port", "8787", "--var", `APP_ORIGIN:${WEB_ORIGIN}`, "--var", "EMAIL_DEV_LOG:1"], {
    cwd: path.join(root, "services/api"),
    stdio: "inherit",
  }),
  spawn("pnpm", ["exec", "vite"], { cwd: path.join(root, "apps/web"), stdio: "inherit" }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
