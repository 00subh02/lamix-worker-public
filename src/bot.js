import http from "node:http";
import { loadConfig } from "./config.js";
import { LamixClient, AuthError, sleep } from "./lamix.js";
import { MatrixClient } from "./matrix.js";
import { State } from "./state.js";
import { CliStore } from "./clis.js";
import { escapeHtml, sendTelegram, splitMessage, discoverChatId, verifyBot } from "./telegram.js";

const config = loadConfig();
const state = new State(config.stateFile);
const cliStore = new CliStore({ file: config.cliFile });
const health = {
  startedAt: new Date().toISOString(),
  lastCycleAt: null,
  lastSuccessAt: null,
  lastError: null,
  alertsSent: 0,
  cycle: 0,
  consecutiveFailures: 0,
  lastCycleMs: null,
  lastMatrixRefreshAt: null,
  matrixError: null,
  cliCount: 0,
  cliOffset: 0,
  lamixRestarts: 0,
  matrixRestarts: 0,
  telegramErrors: 0,
};
let chatIds = config.telegram.chatIds?.length ? [...config.telegram.chatIds] : config.telegram.chatId ? [config.telegram.chatId] : [];
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function warn(m) { console.warn(`[${new Date().toISOString()}] ${m}`); }
const logger = { info: log, warn, error: warn };

export function parseServerTime(value) {
  if (!value) return null;
  let text = String(value).trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(text)) text += ":00";
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
function formatAge(ageMs) {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s ago`;
}
function formatUtc(ms, { withDate = false } = {}) {
  const iso = new Date(ms).toISOString();
  return withDate ? `${iso.replace("T", " ").slice(0, 19)} UTC` : `${iso.slice(11, 19)} UTC`;
}
function buildMessage(cycles, total) {
  const nowMs = Math.max(...cycles.map((c) => c.serverNowMs));
  const prioritySet = new Set((config.priorityClis ?? []).map((c) => String(c).toLowerCase()));
  const hasPriorityHit = cycles.some(
    (c) => c.alerts.length > 0 && prioritySet.has(String(c.cli).toLowerCase()),
  );
  const header = hasPriorityHit ? "🔥" : "🚨";
  const lines = [
    `${header} <b>${hasPriorityHit ? "PRIORITY CLI alert" : "CLI alert"}</b> — ${total} range${total === 1 ? "" : "s"} hit in the last ${config.windowMinutes} min`,
    `🕒 ${formatUtc(nowMs, { withDate: true })}`,
  ];
  // Sort: priority CLIs first so the hottest sender is at the top
  const sortedCycles = [...cycles].sort((a, b) => {
    const aP = prioritySet.has(String(a.cli).toLowerCase()) ? 0 : 1;
    const bP = prioritySet.has(String(b.cli).toLowerCase()) ? 0 : 1;
    if (aP !== bP) return aP - bP;
    return (b.alerts.length || 0) - (a.alerts.length || 0);
  });
  for (const cycle of sortedCycles) {
    if (!cycle.alerts.length) continue;
    const isPriority = prioritySet.has(String(cycle.cli).toLowerCase());
    const emoji = isPriority ? "🔥" : "•";
    lines.push(
      "",
      `${emoji} <b>${escapeHtml(cycle.cli)}</b>${isPriority ? " ⭐ PRIORITY" : ""} — ${cycle.alerts.length} hit${cycle.alerts.length === 1 ? "" : "s"}`,
    );
    for (const a of cycle.alerts) {
      lines.push(`  • <b>${escapeHtml(a.range)}</b>`, `     ${formatAge(a.ageMs)} · last seen ${formatUtc(a.lastSeenMs)}`);
    }
  }
  lines.push("", `<i>Source: lamix panel CLI Search · last ${config.windowMinutes} min · ${cliStore.clis.length} CLIs tracked</i>`);
  return lines.join("\n");
}

async function refreshMatrixIfNeeded(matrix, force = false) {
  const nowMs = Date.now();
  const last = health.lastMatrixRefreshAt ? new Date(health.lastMatrixRefreshAt).getTime() : 0;
  if (!force && nowMs - last < config.matrix.refreshMinutes * 60 * 1000) return;

  if (!config.matrix.enabled) {
    // Use manual + saved CLIs only
    cliStore.merge([config.manualClis]);
    health.cliCount = cliStore.clis.length;
    log(`[clis] manual/saved pool: ${cliStore.clis.length}`);
    return;
  }

  log(`[matrix] refreshing CLI list (every ${config.matrix.refreshMinutes} min)`);
  try {
    await matrix.ensureSession().catch(async () => { await matrix.login(); });
    const result = await matrix.harvest();
    const { added, total } = cliStore.merge([config.manualClis, result.all]);
    cliStore.setMeta({
      manual: config.manualClis,
      matrixLiveFeed: result.liveFeed?.length ?? 0,
      matrixAnnouncements: result.announcements?.length ?? 0,
      matrixFailed: result.failed?.length ?? 0,
      matrixMeta: result.meta ?? null,
      lastMatrixAdded: added,
      lastMatrixTotal: total,
    });
    health.lastMatrixRefreshAt = new Date().toISOString();
    health.matrixError = null;
    health.cliCount = total;
    log(`[clis] Matrix harvest done — ${total} unique CLIs saved to ${config.cliFile} (added ${added})`);
    if (total === 0) warn("[clis] WARNING: 0 CLIs found from Matrix. Check MATRIX_USERNAME/PASSWORD.");
  } catch (err) {
    health.matrixError = err.message;
    warn(`[matrix] refresh failed: ${err.message}`);
    cliStore.merge([config.manualClis]);
    health.cliCount = cliStore.clis.length;
    health.lastMatrixRefreshAt = new Date().toISOString(); // avoid hammering on failure
  }
}

async function runCycle(client) {
  const allClis = cliStore.snapshot();
  if (allClis.length === 0) {
    warn("[clis] no CLIs to search yet — check Matrix login / LAMIX_CLIS");
    return { sent: 0, cycles: [] };
  }

  // Shard rotation for large pools — priority CLIs are always checked first,
  // every cycle, so hot senders (e.g. Lark) get 0-2 min coverage even with 250+ CLIs.
  let batch = allClis;
  const priorityClis = config.priorityClis ?? [];
  const prioritySet = new Set(priorityClis.map((c) => String(c).toLowerCase()));

  // Build ordered list: priority CLIs first, then the rest alphabetically
  const orderedAll = [...allClis];
  // Ensure priority CLIs are in the store even if Matrix never returned them
  for (const pc of priorityClis) {
    if (!cliStore.clis.some((c) => String(c).toLowerCase() === String(pc).toLowerCase())) {
      cliStore.merge([[pc]]);
    }
  }
  const allFresh = [...cliStore.snapshot()].sort((a, b) => {
    const aP = prioritySet.has(String(a).toLowerCase()) ? 0 : 1;
    const bP = prioritySet.has(String(b).toLowerCase()) ? 0 : 1;
    if (aP !== bP) return aP - bP;
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  });

  if (config.clisPerCycle > 0) {
    const total = allFresh.length;
    const priorityInList = allFresh.filter((c) => prioritySet.has(String(c).toLowerCase()));
    const rest = allFresh.filter((c) => !prioritySet.has(String(c).toLowerCase()));
    const restPerCycle = Math.max(0, config.clisPerCycle - priorityInList.length);
    const start = rest.length > 0 ? health.cliOffset % rest.length : 0;
    const restBatch = [];
    for (let i = 0; i < Math.min(restPerCycle, rest.length); i++) restBatch.push(rest[(start + i) % rest.length]);
    health.cliOffset = rest.length > 0 ? (start + restPerCycle) % rest.length : 0;
    batch = [...priorityInList, ...restBatch];
    log(`[batch] searching ${batch.length}/${total} CLIs (priority ${priorityInList.join(",") || "none"} + ${restBatch.length} rotate, offset ${start} next=${health.cliOffset})`);
  }

  // Apply MAX_CLIS cap if set
  if (config.maxClis > 0 && batch.length > config.maxClis) batch = batch.slice(0, config.maxClis);

  const cycles = [];
  for (const cli of batch) {
    try {
      const result = await client.searchCli(cli);
      const { rows, serverNowMs } = result;
      const alerts = [];
      const cooldownMs = config.rangeCooldownMinutes * 60 * 1000;
      for (const row of rows) {
        const range = String(row.range ?? "").trim();
        const lastSeenMs = parseServerTime(row.lastSeen);
        if (!range || lastSeenMs === null) continue;
        const ageMs = serverNowMs - lastSeenMs;
        if (ageMs > config.windowMinutes * 60 * 1000) continue;
        if (ageMs < -config.futureSkewSeconds * 1000) continue;
        const exactKey = `${cli}|${range}|${row.lastSeen}`;
        if (state.wasAlerted(exactKey)) continue;
        const rangeKey = `${cli}|${range}`;
        if (state.rangeCooldownActive(rangeKey, serverNowMs, cooldownMs)) continue;
        alerts.push({ range, lastSeenMs, ageMs, exactKey, rangeKey });
      }
      alerts.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
      cycles.push({ cli, alerts, serverNowMs });
      log(`checked "${cli}": ${rows.length} row(s), ${alerts.length} new hit(s)` + (result.capped ? " (capped)" : ""));
    } catch (err) {
      if (err instanceof AuthError) throw err;
      warn(`CLI "${cli}" failed: ${err.message}`);
    }
  }

  const total = cycles.reduce((s, c) => s + c.alerts.length, 0);
  if (total === 0) return { sent: 0, cycles };

  if (!chatIds.length && !config.dryRun) {
    const discovered = await discoverChatId({ token: config.telegram.token, logger });
    if (discovered) chatIds = [discovered];
  }
  if (!chatIds.length && !config.dryRun) {
    warn("[telegram] no chat id — add the bot to your group and send any message, then set TELEGRAM_CHAT_ID");
    return { sent: 0, cycles };
  }

  const message = buildMessage(cycles, total);
  const parts = splitMessage(message);
  // Broadcast to every group (user locks bot to 2 GCs)
  for (const part of parts) {
    for (const cid of chatIds) {
      try {
        await sendTelegram({ token: config.telegram.token, chatId: cid, text: part, dryRun: config.dryRun, logger });
      } catch (err) {
        health.telegramErrors += 1;
        warn(`[telegram] send to ${cid} failed: ${err.message}`);
      }
      if (!config.dryRun) await sleep(600);
    }
  }
  const sentAt = Math.max(...cycles.map((c) => c.serverNowMs));
  for (const c of cycles) for (const a of c.alerts) state.markAlerted(a.exactKey, a.rangeKey, sentAt);
  state.save();
  health.alertsSent += total;
  log(`${config.dryRun ? "prepared dry-run" : "sent Telegram"} alert for ${total} range(s)`);
  return { sent: total, cycles };
}

function startHealthServer() {
  if (!config.port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      const uptimeSeconds = Math.round((Date.now() - new Date(health.startedAt).getTime()) / 1000);
      const healthy = !health.lastError && (!health.lastSuccessAt || Date.now() - new Date(health.lastSuccessAt).getTime() < 10 * 60 * 1000);
      res.end(JSON.stringify({
        ok: healthy,
        uptimeSeconds,
        uptimeHuman: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
        ...health,
        clisTracked: cliStore.clis.length,
        windowMinutes: config.windowMinutes,
        pollSeconds: config.pollSeconds,
        priorityClis: config.priorityClis,
        telegramChatIds: chatIds,
        memory: process.memoryUsage(),
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Lamix CLI bot is running.\n");
  });
  server.listen(config.port, "0.0.0.0", () => log(`health server listening on :${config.port}`));
  return server;
}

function startSelfPing() {
  const { url, minutes, enabled } = config.selfPing;
  if (!enabled || !url) {
    log("[self-ping] disabled (set SELF_PING_URL=https://<your-app>.onrender.com/healthz)");
    return null;
  }
  const intervalMs = minutes * 60 * 1000;
  const ping = async () => {
    try {
      const res = await fetch(url, { method: "GET" });
      log(`[self-ping] GET ${url} -> ${res.status}`);
    } catch (err) {
      warn(`[self-ping] failed: ${err.message}`);
    }
  };
  ping();
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  log(`[self-ping] every ${minutes} min -> ${url}`);
  return timer;
}

async function main() {
  log(`starting Lamix CLI bot | CLIs source: ${config.matrix.enabled ? "Matrix + manual" : "manual only"}`);
  log(`poll ${config.pollSeconds}s · window ${config.windowMinutes} min · cooldown ${config.rangeCooldownMinutes} min · matrix refresh ${config.matrix.refreshMinutes} min`);
  log(`CLI file: ${config.cliFile} · State file: ${config.stateFile}${config.dryRun ? " · DRY RUN" : ""}`);

  if (!config.dryRun) await verifyBot({ token: config.telegram.token, logger });
  if (!chatIds.length && !config.dryRun) {
    const discovered = await discoverChatId({ token: config.telegram.token, logger });
    if (discovered) {
      chatIds = [discovered];
      process.env.TELEGRAM_CHAT_ID = discovered;
      log(`[telegram] using auto-discovered chat id: ${discovered}`);
      log(`[telegram] TIP: also set TELEGRAM_CHAT_ID=${discovered} in env for Render`);
    } else {
      warn("[telegram] TELEGRAM_CHAT_ID not set and no auto-discovered chat. Add bot to group, send a message, then restart.");
    }
  } else if (chatIds.length) {
    log(`[telegram] chat ids: ${chatIds.join(", ")}`);
  }

  const server = startHealthServer();
  startSelfPing();

  const lamix = new LamixClient({
    baseUrl: config.lamix.baseUrl,
    username: config.lamix.username,
    password: config.lamix.password,
    headless: config.headless,
    logger,
  });

  let matrix = null;
  if (config.matrix.enabled && config.matrix.username && config.matrix.password) {
    matrix = new MatrixClient({
      baseUrl: config.matrix.baseUrl,
      username: config.matrix.username,
      password: config.matrix.password,
      headless: config.headless,
      logger,
    });
    try { await matrix.start(); } catch (err) { warn(`[matrix] start failed: ${err.message} — will retry in loop`); }
  } else if (config.matrix.enabled) {
    warn("[matrix] MATRIX_USERNAME/PASSWORD not set — using manual CLIs only. Add them to get auto-harvest.");
  }

  try { await lamix.start(); } catch (err) { console.error(`[fatal] Lamix start failed: ${err.message}`); process.exit(1); }

  // Watchdog + auto-recovery: never stay dead.
  let running = true;
  let restartRequested = false;
  let fatalStreak = 0;
  const shutdown = async (signal) => {
    if (!running) return;
    running = false;
    log(`received ${signal}, shutting down`);
    server?.close();
    await lamix.stop().catch(() => {});
    await matrix?.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Uncaught error hooks: log and let the watchdog restart, never silently die
  process.on("uncaughtException", (err) => {
    console.error(`[uncaught] ${err.stack || err.message}`);
    health.lastError = err.message;
    health.consecutiveFailures += 1;
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[unhandled] ${err?.stack || err}`);
    health.lastError = err?.message || String(err);
  });

  // Initial Matrix harvest (unless --scan-once requires it explicitly)
  if (matrix) await refreshMatrixIfNeeded(matrix, true);
  else cliStore.merge([config.manualClis]);

  if (config.scanOnce) {
    log(`[scan-once] CLIs saved: ${cliStore.clis.length} -> ${config.cliFile}`);
    console.log(JSON.stringify(cliStore.snapshot(), null, 2));
    await lamix.stop().catch(() => {});
    await matrix?.stop().catch(() => {});
    server?.close();
    return;
  }

  while (running) {
    const startedAt = Date.now();
    health.cycle += 1;
    health.lastCycleAt = new Date().toISOString();
    try {
      if (restartRequested) {
        await lamix.restart();
        health.lamixRestarts += 1;
        restartRequested = false;
      }
      if (matrix) await refreshMatrixIfNeeded(matrix, false);
      await runCycle(lamix);
      health.lastSuccessAt = new Date().toISOString();
      health.lastError = null;
      health.consecutiveFailures = 0;
      fatalStreak = 0;
      health.lastCycleMs = Date.now() - startedAt;
    } catch (err) {
      health.lastError = err.message;
      health.consecutiveFailures += 1;
      fatalStreak += 1;
      health.lastCycleMs = Date.now() - startedAt;
      warn(`cycle failed (${fatalStreak} in a row): ${err.message}`);
      // Auto-restart browser on auth/crash, backoff harder after repeated failures
      if (err instanceof AuthError || /crash|closed|Target page/i.test(err.message)) {
        restartRequested = true;
      }
      if (fatalStreak >= 3) {
        warn(`[watchdog] ${fatalStreak} consecutive failures — full restart in 10s`);
        await sleep(10000);
        await lamix.restart().catch((e) => warn(`lamix restart failed: ${e.message}`));
        health.lamixRestarts += 1;
        restartRequested = false;
      }
    }
    if (state.prune(Date.now()) > 0) state.save();
    if (config.once) break;
    const elapsed = Date.now() - startedAt;
    // Smooth pacing: keep at least 5s gap between cycles to avoid 429 storms
    const waitMs = Math.max(5000, config.pollSeconds * 1000 - elapsed);
    await sleep(waitMs);
  }
  await lamix.stop().catch(() => {});
  await matrix?.stop().catch(() => {});
  server?.close();
  log("stopped");
}

main().catch((err) => { console.error(`[fatal] ${err.stack || err.message}`); process.exit(1); });
