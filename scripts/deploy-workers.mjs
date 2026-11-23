/**
 * Create or sync one Lamix worker web service per Render account.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/deploy-workers.mjs
 *
 * Tokens live ONLY in ./render-workers.json (gitignored). Never commit it.
 * Each entry:
 *   {
 *     "token": "rnd_...",
 *     "region": "oregon",            // oregon | ohio | virginia | frankfurt | singapore
 *     "serviceName": "lamix-worker-1",
 *     "serviceId": "srv-...",        // set after first creation; used for env sync
 *     "workerId": 0,                 // shard id, unique per live worker
 *     "workerTotal": 3,              // number of live workers (PC excluded)
 *     "lamixUsername": "AK_Ayesha",
 *     "lamixPassword": "AK_Ayesha",
 *     "ownerId": "tea_optional"      // optional: otherwise first owner is used
 *   }
 *
 * IMPORTANT: Render's PUT /services/:id/env-vars REPLACES the whole list.
 * Always send the complete env set, including self-ping vars.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const REPO = "https://github.com/00subh02/lamix-worker-public";

const workers = JSON.parse(await readFile(path.join(root, "render-workers.json"), "utf8"));
if (!Array.isArray(workers) || workers.length === 0) throw new Error("render-workers.json is empty");
// The PC bot is stopped, so the live fleet is exactly the Render workers.
const totalWorkers = Number(process.env.WORKER_TOTAL ?? workers.length);

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
  if (res.status === 429) {
    const err = new Error(`rate-limited (reset in ${res.headers.get("ratelimit-reset") ?? "?"}s)`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function env(key, value) {
  return { key, value: String(value ?? "") };
}

function buildEnvVars(w, url) {
  const pingUrl = url ? `${url.replace(/\/+$/, "")}/healthz` : "";
  // Render's PUT /env-vars keeps only ~20 entries. Keep every non-default
  // setting here; everything omitted has the correct default in config.js.
  return [
    env("LAMIX_USERNAME", w.lamixUsername),
    env("LAMIX_PASSWORD", w.lamixPassword),
    env("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN),
    env("TELEGRAM_CHAT_ID", process.env.TELEGRAM_CHAT_ID ?? "-1004451914143"),
    env("TELEGRAM_COMMANDS_ENABLED", "false"), // only one bot instance may poll getUpdates
    env("MATRIX_USERNAME", process.env.MATRIX_USERNAME),
    env("MATRIX_PASSWORD", process.env.MATRIX_PASSWORD),
    env("MATRIX_REFRESH_MINUTES", "1"),
    env("SIGNAL_ENABLED", "false"),
    env("CLIS_PER_CYCLE", "0"), // check the entire shard every cycle
    env("WINDOW_MINUTES", "2"),
    env("RANGE_COOLDOWN_MINUTES", "0"),
    env("CYCLE_SECONDS", "180"), // pacing 800ms comes from config default
    env("WORKER_ID", w.workerId),
    env("WORKER_TOTAL", w.workerTotal ?? totalWorkers),
    env("PORT", "10000"),
    env("SELF_PING_ENABLED", pingUrl ? "true" : "false"),
    env("SELF_PING_URL", pingUrl),
    env("SELF_PING_RANDOM", "1-9"), // random keep-alive every 1..9 minutes
  ];
}

async function syncEnv(w, serviceId, url) {
  const vars = buildEnvVars(w, url);
  await api(w.token, `/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(vars),
  });
  const check = await api(w.token, `/services/${serviceId}/env-vars`);
  const keys = (Array.isArray(check) ? check : []).map((x) => x.envVar ?? x).map((v) => v.key);
  const missing = ["TELEGRAM_BOT_TOKEN", "MATRIX_PASSWORD", "LAMIX_USERNAME", "WORKER_ID", "WORKER_TOTAL", "SELF_PING_ENABLED"].filter((k) => !keys.includes(k));
  if (missing.length) throw new Error(`env sync incomplete for ${serviceId}: missing ${missing.join(", ")}`);
  console.log(`       env synced (${keys.length} vars), self-ping=${url ? "on" : "off"}`);
}

for (const w of workers) {
  const name = w.serviceName ?? `lamix-worker-${w.workerId}`;
  if (!w.token) throw new Error(`${name}: missing token`);
  if (!w.lamixUsername || !w.lamixPassword) throw new Error(`${name}: missing Lamix credentials`);

  try {
    const owners = await api(w.token, "/owners");
    const ownerList = owners.map((o) => o.owner ?? o);
    const owner = w.ownerId
      ? ownerList.find((o) => o.id === w.ownerId)
      : ownerList.find((o) => o.type === "team") ?? ownerList[0];
    if (!owner) throw new Error(`${name}: no Render owner found`);

    const existing = await api(w.token, "/services?limit=100");
    const all = existing.map((s) => s.service ?? s);
    const already = all.find((s) => w.serviceId && s.id === w.serviceId)
      ?? all.find((s) => s.name === name);

    if (already) {
      const sid = already.id;
      const url = already.serviceDetails?.url ?? already.url ?? "";
      console.log(`SYNC  ${name}: ${sid} shard=${w.workerId}/${w.workerTotal ?? totalWorkers}`);
      await syncEnv(w, sid, url);
      continue;
    }

    const created = await api(w.token, "/services", {
      method: "POST",
      body: JSON.stringify({
        type: "web_service",
        name,
        ownerId: owner.id,
        repo: REPO,
        branch: "main",
        autoDeployTrigger: "commit",
        envVars: buildEnvVars(w, ""),
        serviceDetails: {
          runtime: "docker",
          plan: w.plan ?? "free",
          region: w.region ?? "oregon",
          healthCheckPath: "/healthz",
        },
      }),
    });
    const svc = created.service ?? created;
    const url = svc.serviceDetails?.url ?? svc.url ?? "";
    console.log(`CREATE ${name}: region=${w.region ?? "oregon"} owner=${owner.id} id=${svc.id}`);
    console.log(`       url=${url || "pending"} — add "serviceId": "${svc.id}" to render-workers.json`);
    if (url) await syncEnv(w, svc.id, url);
  } catch (err) {
    if (err.rateLimited) {
      console.log(`SKIP  ${name}: rate-limited, rerun after reset.`);
      continue;
    }
    throw err;
  }
}
console.log("Done. Verify each /healthz shows worker.id/total and rising searchesDone.");
