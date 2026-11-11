import http from "node:http";
import { loadConfig } from "./config.js";
import { LamixClient, AuthError, RateLimitError, sleep } from "./lamix.js";
import { MatrixClient } from "./matrix.js";
import { SignalPulseClient } from "./signal.js";
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
  signalRestarts: 0,
  lastSignalRefreshAt: null,
  signalError: null,
  telegramErrors: 0,
  rateLimitHits: 0,
  rateLimitedUntil: null,
  searchesDone: 0,
  last429At: null,
  paceMs: null,
};
let chatIds = config.telegram.chatIds?.length ? [...config.telegram.chatIds] : config.telegram.chatId ? [config.telegram.chatId] : [];
let hotClis = [];
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
  return r ? `${m}m ${String(r).padStart(2, "0")}s ago` : `${m}m ago`;
}
function formatUtc(ms) {
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  const iso = ist.toISOString();
  return `${iso.slice(11, 19)} IST`;
}
function formatIstDate(ms) {
  const istMs = ms + 5.5 * 60 * 60 * 1000;
  const d = new Date(istMs);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const time = d.toISOString().slice(11, 19);
  const date = d.toISOString().slice(0, 10);
  return `${time} IST · ${day} ${date} (${mon})`;
}
function formatIstShort(ms) {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  let hours = d.getUTCHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm} IST`;
}
function formatIstStamp(ms) {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()} · ${formatIstShort(ms)}`;
}
function buildMessage(cycles, total) {
  const nowMs = Math.max(...cycles.map((c) => c.serverNowMs));
  const clisTracked = cliStore.clis.length;
  const checked = cycles.length;

  const prioritySet = new Set((config.priorityClis ?? []).map((c) => String(c).toLowerCase()));
  const hasPriorityHit = cycles.some(
    (c) => c.alerts.length > 0 && prioritySet.has(String(c.cli).toLowerCase()),
  );

  // Sort: priority CLIs first, then by alert count desc
  const sortedCycles = [...cycles].sort((a, b) => {
    const aP = prioritySet.has(String(a.cli).toLowerCase()) ? 0 : 1;
    const bP = prioritySet.has(String(b.cli).toLowerCase()) ? 0 : 1;
    if (aP !== bP) return aP - bP;
    return (b.alerts.length || 0) - (a.alerts.length || 0);
  });

  const rangeWord = total === 1 ? "RANGE" : "RANGES";
  const cliWord = checked === 1 ? "CLI" : "CLIs";
  const priorityNames = [...new Set(
    cycles
      .filter((c) => c.alerts.length && prioritySet.has(String(c.cli).toLowerCase()))
      .map((c) => String(c.cli).toUpperCase()),
  )];
  const priorityLabel = priorityNames.length === 1 ? priorityNames[0] : "PRIORITY";

  const lines = [
    `🚨 <b>LAMIX CLI ALERT</b>`,
    `${formatIstStamp(nowMs)} · 0-${config.windowMinutes} MIN · ${total} ${rangeWord}`,
  ];
  if (hasPriorityHit) lines.push(`<b>PRIORITY HIT — ${escapeHtml(priorityLabel)}</b>`);
  lines.push("");

  for (const cycle of sortedCycles) {
    if (!cycle.alerts.length) continue;
    const multi = cycle.alerts.length > 1;
    lines.push(`<b>CLI:</b> <code>${escapeHtml(cycle.cli)}</code>`);
    cycle.alerts.forEach((a, i) => {
      const num = multi ? `${i + 1}. ` : "";
      lines.push(
        `<b>${num}Range:</b> <code>${escapeHtml(a.range)}</code>`,
        `<b>Time:</b> ${formatAge(a.ageMs)} · ${formatIstShort(a.lastSeenMs)}`,
      );
    });
    lines.push("");
  }

  lines.push(
    `Source: lamix panel · 0-${config.windowMinutes} min`,
    `${checked} ${cliWord} checked · ${clisTracked} tracked · ${config.pollSeconds}s poll`,
  );
  return lines.join("\n");
}

async function refreshSignalIfNeeded(signal, force = false) {
  const nowMs = Date.now();
  const last = health.lastSignalRefreshAt ? new Date(health.lastSignalRefreshAt).getTime() : 0;
  if (!force && nowMs - last < config.signal.refreshMinutes * 60 * 1000) return;
  if (!config.signal.enabled) return;
  log(`[signal] refreshing CLI list (every ${config.signal.refreshMinutes} min)`);
  try {
    const result = await signal.harvest();
    const { added, total } = cliStore.merge([result.all]);
    cliStore.setMeta({ ...cliStore.meta, signal: result.meta, lastSignalAdded: added, lastSignalTotal: total });
    health.lastSignalRefreshAt = new Date().toISOString();
    health.signalError = null;
    log(`[signal] harvest done — ${total} unique CLIs (added ${added})`);
  } catch (err) {
    health.signalError = err.message;
    warn(`[signal] refresh failed: ${err.message}`);
    health.lastSignalRefreshAt = new Date().toISOString();
  }
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
    hotClis = Array.isArray(result.liveFeed) ? result.liveFeed : [];
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

  // Build ordered list: priority CLIs first, then the rest
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

    // Prefer CLIs MatrixPanel currently reports as active: scarce Lamix searches
    // hit senders that are actually live. Every 6th cycle rotates cold CLIs too.
    const hotPool = hotClis.filter(
      (c) => !prioritySet.has(String(c).toLowerCase()) && allClis.includes(c),
    );
    const useCold = hotPool.length === 0 || health.cycle % 6 === 0;
    const restPool = useCold ? rest : hotPool;
    const start = restPool.length > 0 ? health.cliOffset % restPool.length : 0;
    const restBatch = [];
    for (let i = 0; i < Math.min(restPerCycle, restPool.length); i++) {
      restBatch.push(restPool[(start + i) % restPool.length]);
    }
    health.cliOffset = restPool.length > 0 ? (start + restPerCycle) % restPool.length : 0;
    batch = [...priorityInList, ...restBatch];
    log(
      `[batch] searching ${batch.length}/${total} CLIs (priority ${priorityInList.join(",") || "none"} + ${restBatch.length} ${useCold ? "cold" : "hot"} rotate, offset ${start} next=${health.cliOffset})`,
    );
  } else {
    // No batching — priority first, then hot CLIs, then the rest.
    const hotRank = new Map(hotClis.map((c, i) => [String(c).toLowerCase(), i]));
    const restSorted = allFresh
      .filter((c) => !prioritySet.has(String(c).toLowerCase()))
      .sort((a, b) => {
        const ar = hotRank.get(String(a).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        const br = hotRank.get(String(b).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        if (ar !== br) return ar - br;
        return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
      });
    batch = [
      ...allFresh.filter((c) => prioritySet.has(String(c).toLowerCase())),
      ...restSorted,
    ];
  }

  // Apply MAX_CLIS cap if set
  if (config.maxClis > 0 && batch.length > config.maxClis) batch = batch.slice(0, config.maxClis);

  // Cycle timeout guard: never let one batch block past the deadline
  const cycleDeadline = Date.now() + config.cycleSeconds * 1000;
  async function checkCli(cli) {
    if (Date.now() > cycleDeadline) throw new Error("Cycle deadline exceeded");
    const result = await client.searchCli(cli);
    const { rows, serverNowMs } = result;
    health.searchesDone += 1;
    health.paceMs = client.gapMs ?? health.paceMs;
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
    log(`checked "${cli}": ${rows.length} row(s), ${alerts.length} new hit(s)` + (result.capped ? " (capped)" : ""));
    return { cli, alerts, serverNowMs };
  }

  async function sendAlerts(cyclesToSend) {
    const totalToSend = cyclesToSend.reduce((s, c) => s + c.alerts.length, 0);
    if (totalToSend === 0) return 0;
    if (!chatIds.length && !config.dryRun) {
      const discovered = await discoverChatId({ token: config.telegram.token, logger });
      if (discovered) chatIds = [discovered];
    }
    if (!chatIds.length && !config.dryRun) {
      warn("[telegram] no chat id — add the bot to your group and send any message, then set TELEGRAM_CHAT_ID");
      return 0;
    }
    const message = buildMessage(cyclesToSend, totalToSend);
    const parts = splitMessage(message);
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
    const sentAt = Math.max(...cyclesToSend.map((c) => c.serverNowMs));
    for (const c of cyclesToSend) for (const a of c.alerts) state.markAlerted(a.exactKey, a.rangeKey, sentAt);
    state.save();
    health.alertsSent += totalToSend;
    log(`${config.dryRun ? "prepared dry-run" : "sent Telegram"} alert for ${totalToSend} range(s)`);
    return totalToSend;
  }

  const priorityBatch = batch.filter((c) => prioritySet.has(String(c).toLowerCase()));
  const restBatch = batch.filter((c) => !prioritySet.has(String(c).toLowerCase()));

  const markRateLimited = (err) => {
    health.rateLimitHits = client.rateLimitHits ?? health.rateLimitHits;
    health.last429At = client.last429At ?? new Date().toISOString();
    health.rateLimitedUntil = new Date(Date.now() + (err.retryAfterSeconds ?? 300) * 1000).toISOString();
    health.paceMs = client.gapMs ?? health.paceMs;
    health.cooldownMs = client.cooldownMs ?? health.cooldownMs;
    warn(`[rate-limit] ${err.message} — pausing searches until ${health.rateLimitedUntil} (pace ${client.gapMs}ms, cooldown ${client.cooldownMs}ms)`);
  };

  // 1) Priority fast-path (Lark every cycle)
  const priorityCycles = [];
  let limited = false;
  for (const cli of priorityBatch) {
    try {
      const cycle = await checkCli(cli);
      priorityCycles.push(cycle);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof RateLimitError) {
        markRateLimited(err);
        limited = true;
        break;
      }
      warn(`CLI "${cli}" failed: ${err.message}`);
    }
  }
  await sendAlerts(priorityCycles);

  // 2) Rotate the rest — stop immediately when Lamix asks us to back off
  const cycles = [...priorityCycles];
  for (const cli of restBatch) {
    if (limited) break;
    try {
      const cycle = await checkCli(cli);
      cycles.push(cycle);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof RateLimitError) {
        markRateLimited(err);
        limited = true;
        break;
      }
      warn(`CLI "${cli}" failed: ${err.message}`);
    }
  }

  // Send the rest (priority already sent above, so only send non-priority hits now)
  const restCycles = cycles.filter((c) => !prioritySet.has(String(c.cli).toLowerCase()));
  await sendAlerts(restCycles);

  const totalSent = priorityCycles.reduce((s, c) => s + c.alerts.length, 0) + restCycles.reduce((s, c) => s + c.alerts.length, 0);
  return { sent: totalSent, cycles };
}

function startHealthServer() {
  if (!config.port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      const uptimeSeconds = Math.round((Date.now() - new Date(health.startedAt).getTime()) / 1000);
      const healthy = !health.lastError && (!health.lastSuccessAt || Date.now() - new Date(health.lastSuccessAt).getTime() < 15 * 60 * 1000);
      res.end(JSON.stringify({
        ok: true, // Always 200 for Render — liveness, not readiness
        healthy,
        uptimeSeconds,
        uptimeHuman: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
        ...health,
        okReason: healthy ? "healthy" : health.lastError || "degraded",
        clisTracked: cliStore.clis.length,
        windowMinutes: config.windowMinutes,
        pollSeconds: config.pollSeconds,
        priorityClis: config.priorityClis,
        telegramChatIds: chatIds,
        hotClis: hotClis.length,
        rateLimitedForSeconds: Math.max(0, Math.ceil(((health.rateLimitedUntil ? new Date(health.rateLimitedUntil).getTime() : 0) - Date.now()) / 1000)),
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
  const { url, minutes, enabled, urls } = config.selfPing;
  const targets = urls?.length ? urls : url ? [url] : [];
  if (!enabled || targets.length === 0) {
    log("[self-ping] disabled (set SELF_PING_URL=https://<your-app>.onrender.com/healthz)");
    return null;
  }
  const intervalMs = minutes * 60 * 1000;
  const ping = async () => {
    for (const u of targets) {
      try {
        // Cache-bust so Render/Cloudflare never serve a cached /healthz (must hit origin)
        const bust = `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;
        const res = await fetch(bust, { method: "GET", redirect: "follow" });
        log(`[self-ping] GET ${u} -> ${res.status} (keep-alive)`);
      } catch (err) {
        warn(`[self-ping] ${u} failed: ${err.message}`);
      }
    }
  };
  ping();
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  log(`[self-ping] unlimited keep-alive every ${minutes} min -> ${targets.join(", ")}`);
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

  // SignalPulse client (fast HTTP, no browser) — never blocks on Matrix
  let signal = null;
  if (config.signal.enabled) {
    signal = new SignalPulseClient({ baseUrl: config.signal.baseUrl, logger });
    // Start signal refresh in background — don't block lamix startup (band ho raha fix)
    refreshSignalIfNeeded(signal, true).catch((e) => warn(`[signal] initial refresh failed: ${e.message}`));
  }

  const lamix = new LamixClient({
    baseUrl: config.lamix.baseUrl,
    username: config.lamix.username,
    password: config.lamix.password,
    headless: config.headless,
    logger,
    priorityClis: config.priorityClis,
    searchPacingMs: config.searchPacingMs,
    searchTimeoutMs: config.searchTimeoutMs,
    priorityTimeoutMs: config.priorityTimeoutMs,
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

  // Non-fatal start: if lamix fails, infinite retry (never die, never off)
  let lamixStarted = false;
  for (let attempt = 1; attempt <= 5 && !lamixStarted; attempt++) {
    try {
      await lamix.start();
      lamixStarted = true;
    } catch (err) {
      console.error(`[fatal] Lamix start failed attempt ${attempt}/5: ${err.message} — retrying in 10s`);
      await sleep(10000);
    }
  }
  if (!lamixStarted) {
    console.error("[fatal] Lamix failed after 5 attempts, starting health-only mode (alerts paused, ping continues)");
  }

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
    // Graceful: don't exit immediately, let Render kill if needed
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Inner supervisor: if main loop crashes, restart it (never off)
  process.on("uncaughtException", (err) => {
    console.error(`[uncaught] ${err.stack || err.message}`);
    health.lastError = err.message;
    health.consecutiveFailures += 1;
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[unhandled] ${err?.stack || err}`);
    health.lastError = err?.message || String(err);
  });

  // Always seed manual + priority CLIs so Lark is checked from the first cycle,
  // even when Matrix/SignalPulse harvesting is slow or unavailable.
  cliStore.merge([config.manualClis, config.priorityClis]);
  log(`[clis] pool loaded: ${cliStore.clis.length} CLI(s) (priority: ${config.priorityClis.join(", ") || "none"})`);

  // Initial Matrix harvest (unless --scan-once requires it explicitly) — non-blocking
  if (matrix) {
    refreshMatrixIfNeeded(matrix, true).catch((e) => warn(`[matrix] initial refresh failed: ${e.message}`));
  } else cliStore.merge([config.manualClis]);
  if (signal) {
    refreshSignalIfNeeded(signal, true).catch((e) => warn(`[signal] initial refresh failed: ${e.message}`));
  }

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
      if (signal) await refreshSignalIfNeeded(signal, false);
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
    // Smooth pacing between cycles + honor Lamix 429 cool-down (never hammer a lockout)
    const rateLimitWaitMs = lamix.rateLimitedForSeconds * 1000;
    const waitMs = Math.max(5000, config.pollSeconds * 1000 - elapsed, rateLimitWaitMs);
    await sleep(Math.min(waitMs, 10 * 60 * 1000));
  }
  await lamix.stop().catch(() => {});
  await matrix?.stop().catch(() => {});
  server?.close();
  log("stopped");
}

main().catch((err) => { console.error(`[fatal] ${err.stack || err.message}`); process.exit(1); });
