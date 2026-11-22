/**
 * Create one Lamix worker web service per Render account.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/deploy-workers.mjs
 *
 * Tokens live ONLY in ./render-workers.json (gitignored). Never commit it.
 * Format:
 * [
 *   {
 *     "token": "rnd_...",
 *     "region": "oregon",              // oregon | ohio | virginia | frankfurt | singapore
 *     "workerId": 1,
 *     "lamixUsername": "AK_Ayesha",
 *     "lamixPassword": "AK_Ayesha",
 *     "ownerId": "tea_optional"        // optional: otherwise first owner is used
 *   },
 *   ...
 * ]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const REPO = "https://github.com/00subh02/lamix-cli-bot.git";

const workers = JSON.parse(await readFile(path.join(root, "render-workers.json"), "utf8"));
if (!Array.isArray(workers) || workers.length === 0) throw new Error("render-workers.json is empty");
const totalWorkers = Number(process.env.WORKER_TOTAL ?? workers.length + 1);

async function api(token, url, options = {}) {
  const res = await fetch(`${API}${url}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function env(key, value) {
  return { key, value: String(value ?? "") };
}

for (const w of workers) {
  if (!w.token) throw new Error(`worker ${w.workerId}: missing token`);
  if (!w.lamixUsername || !w.lamixPassword) throw new Error(`worker ${w.workerId}: missing Lamix credentials`);

  const owners = await api(w.token, "/owners");
  const ownerList = owners.map((o) => o.owner ?? o);
  const owner = w.ownerId
    ? ownerList.find((o) => o.id === w.ownerId)
    : ownerList.find((o) => o.type === "team") ?? ownerList[0];
  if (!owner) throw new Error(`worker ${w.workerId}: no Render owner found`);

  const name = `lamix-worker-${w.workerId}`;
  const existing = await api(w.token, "/services?limit=100");
  const already = existing.map((s) => s.service ?? s).find((s) => s.name === name);
  if (already) {
    console.log(`SKIP  ${name}: already exists (${already.id}) at https://dashboard.render.com/web/${already.id}`);
    continue;
  }

  const envVars = [
    env("LAMIX_BASE_URL", "https://panel.lamix.org"),
    env("LAMIX_USERNAME", w.lamixUsername),
    env("LAMIX_PASSWORD", w.lamixPassword),
    env("LAMIX_ACCOUNTS", ""), // one browser/account per 512 MB free worker
    env("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN),
    env("TELEGRAM_CHAT_ID", process.env.TELEGRAM_CHAT_ID ?? "-1004451914143"),
    env("TELEGRAM_COMMANDS_ENABLED", "false"), // only the PC worker polls commands
    env("MATRIX_BASE_URL", "https://matrixpanel.io"),
    env("MATRIX_ENABLED", "true"),
    env("MATRIX_USERNAME", process.env.MATRIX_USERNAME),
    env("MATRIX_PASSWORD", process.env.MATRIX_PASSWORD),
    env("MATRIX_REFRESH_MINUTES", "1"),
    env("SIGNAL_ENABLED", "false"),
    env("CLIS_PER_CYCLE", "400"),
    env("WINDOW_MINUTES", "2"),
    env("RANGE_COOLDOWN_MINUTES", "0"),
    env("POLL_SECONDS", "10"),
    env("SEARCH_PACING_MS", "5000"),
    env("CYCLE_SECONDS", "300"),
    env("WORKER_ID", w.workerId),
    env("WORKER_TOTAL", totalWorkers),
    env("HEADLESS", "true"),
    env("DRY_RUN", "false"),
    env("PORT", "10000"),
    env("SELF_PING_ENABLED", "false"), // set after the service URL is known
    env("TZ", "UTC"),
  ];

  const created = await api(w.token, "/services", {
    method: "POST",
    body: JSON.stringify({
      type: "web",
      name,
      ownerId: owner.id,
      region: w.region ?? "oregon",
      plan: w.plan ?? "free",
      repo: REPO,
      branch: "main",
      autoDeploy: true,
      healthCheckPath: "/healthz",
      dockerfilePath: "./Dockerfile",
      dockerContext: ".",
      envVars,
    }),
  });
  const svc = created.service ?? created;
  const url = svc.serviceDetails?.url ?? svc.url ?? "";
  console.log(`CREATE ${name}: region=${w.region ?? "oregon"} owner=${owner.id} id=${svc.id}`);
  console.log(`       url=${url || "pending"}`);

  // Free Render services spin down without inbound traffic. Turn self-ping on
  // as soon as the URL is known so this worker stays awake 24/7.
  if (url) {
    try {
      await api(w.token, `/services/${svc.id}/env-vars`, {
        method: "PATCH",
        body: JSON.stringify({
          envVars: [
            env("SELF_PING_URL", `${url.replace(/\/+$/, "")}/healthz`),
            env("SELF_PING_ENABLED", "true"),
          ],
        }),
      });
      console.log(`       self-ping enabled -> ${url.replace(/\/+$/, "")}/healthz`);
    } catch (err) {
      console.log(`       WARN: could not auto-set self-ping: ${err.message}`);
    }
  }
}
console.log("Done. Verify each /healthz shows the right worker id and rising searchesDone.");
