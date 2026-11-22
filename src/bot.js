import http from "node:http";
import { loadConfig } from "./config.js";
import { LamixClient, AuthError, RateLimitError, sleep, closeSharedBrowser } from "./lamix.js";
import { MatrixClient } from "./matrix.js";
import { SignalPulseClient } from "./signal.js";
import { State } from "./state.js";
import { CliStore } from "./clis.js";
import { escapeHtml, sendTelegram, splitMessage, discoverChatId, verifyBot } from "./telegram.js";
import { startTelegramCommandPolling } from "./commands.js";

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
  freshOffset: 0,
  lamixRestarts: 0,
  matrixRestarts: 0,
  signalRestarts: 0,
  lastSignalRefreshAt: null,
  signalError: null,
  telegramErrors: 0,
  rateLimitHits: 0,
  lamixAccountErrors: [],
  rateLimitedUntil: null,
  searchesDone: 0,
  last429At: null,
  paceMs: null,
};
let chatIds = config.telegram.chatIds?.length ? [...config.telegram.chatIds] : config.telegram.chatId ? [config.telegram.chatId] : [];
let hotClis = [];
let signalHotClis = [];
let signalFreshClis = [];
let signalRefreshing = false;
let matrixHotClis = [];
let matrixFreshClis = [];
let matrixRefreshing = false;
function uniqLower(list) {
  const seen = new Set();
  const out = [];
  for (const cli of list) {
    const key = String(cli ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cli);
  }
  return out;
}
function rebuildHotClis() {
  // Fresh announcements / recent failed traffic are checked first, then the
  // overall live hot list, and only then the much broader SignalPulse corpus.
  hotClis = uniqLower([...matrixFreshClis, ...matrixHotClis, ...signalHotClis]);
}
/** Fresh = Matrix announcements or very recent failed traffic; Signal first only when enabled. */
function combinedHotClis() {
  return uniqLower([...matrixFreshClis, ...matrixHotClis, ...signalHotClis]);
}
function combinedFreshClis() {
  return uniqLower([...matrixFreshClis, ...signalFreshClis]);
}
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

let degradedNotificationSent = false;

async function sendOfflineTelegramNotice() {
  if (degradedNotificationSent) return false;
  degradedNotificationSent = true;
  try {
    const text =
      "⚠️ <b>BOT ALERT MODE DEGRADED</b>\n\n" +
      "Lamix lookup is not able to deliver new alerts.\n" +
      "The bot itself is still running.";
    for (const chatId of config.telegram.chatIds) {
      await sendTelegram({ token: config.telegram.token, chatId, text, parseMode: "HTML" });
    }
  } catch (err) {
    warn(`[telegram] offline notice failed: ${err.message}`);
    return false;
  }
  return true;
}
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
  if (!config.signal.enabled) return;
  if (signalRefreshing) return;
  const nowMs = Date.now();
  const last = health.lastSignalRefreshAt ? new Date(health.lastSignalRefreshAt).getTime() : 0;
  if (!force && nowMs - last < config.signal.refreshMinutes * 60 * 1000) return;
  signalRefreshing = true;
  log(`[signal] refreshing CLI list (every ${config.signal.refreshMinutes} min)`);
  try {
    const result = await signal.harvest();
    signalHotClis = Array.isArray(result.hot) ? result.hot : [];
    signalFreshClis = Array.isArray(result.fresh) ? result.fresh : [];
    rebuildHotClis();
    const { added, total } = cliStore.merge([result.all]);
    cliStore.setMeta({ ...cliStore.meta, signal: result.meta, lastSignalAdded: added, lastSignalTotal: total });
    health.lastSignalRefreshAt = new Date().toISOString();
    health.signalError = null;
    health.signalClis = result.all.length;
    health.signalHotClis = signalHotClis.length;
    health.cliCount = total;
    log(
      `[signal] harvest done — ${result.all.length} source CLIs (${result.meta?.numeric ?? 0} numeric), ` +
        `${signalHotClis.length} hot · store ${total} unique (added ${added})`,
    );
  } catch (err) {
    health.signalError = err.message;
    warn(`[signal] refresh failed: ${err.message}`);
    health.lastSignalRefreshAt = new Date().toISOString();
  } finally {
    signalRefreshing = false;
  }
}

async function refreshMatrixIfNeeded(matrix, force = false) {
  const nowMs = Date.now();
  const last = health.lastMatrixRefreshAt ? new Date(health.lastMatrixRefreshAt).getTime() : 0;
  if (matrixRefreshing) return;
  if (!force && nowMs - last < config.matrix.refreshMinutes * 60 * 1000) return;

  if (!config.matrix.enabled) {
    // Use manual + saved CLIs only
    cliStore.merge([config.manualClis]);
    health.cliCount = cliStore.clis.length;
    log(`[clis] manual/saved pool: ${cliStore.clis.length}`);
    return;
  }

  matrixRefreshing = true;
  log(`[matrix] refreshing CLI list (every ${config.matrix.refreshMinutes} min)`);
  try {
    await matrix.ensureSession().catch(async () => { await matrix.login(); });
    const result = await matrix.harvest();
    matrixFreshClis = Array.isArray(result.fresh) ? result.fresh : [];
    matrixHotClis = Array.isArray(result.hot) ? result.hot : [];
    rebuildHotClis();
    const { added, total } = cliStore.merge([config.manualClis, result.all]);
    cliStore.setMeta({
      manual: config.manualClis,
      matrixLiveFeed: result.liveFeed?.length ?? 0,
      matrixAnnouncements: result.announcements?.length ?? 0,
      matrixFailed: result.failed?.length ?? 0,
      matrixMeta: result.meta ?? null,
      matrixHot: matrixHotClis.length,
      matrixFresh: matrixFreshClis.length,
      lastMatrixAdded: added,
      lastMatrixTotal: total,
    });
    health.lastMatrixRefreshAt = new Date().toISOString();
    health.matrixError = null;
    health.cliCount = total;
    health.matrixHotClis = matrixHotClis.length;
    health.matrixFreshClis = matrixFreshClis.length;
    log(
      `[clis] Matrix harvest done — ${total} unique CLIs saved to ${config.cliFile} ` +
        `(added ${added}, fresh ${matrixFreshClis.length}, hot ${matrixHotClis.length})`,
    );
    if (total === 0) warn("[clis] WARNING: 0 CLIs found from Matrix. Check MATRIX_USERNAME/PASSWORD.");
  } catch (err) {
    health.matrixError = err.message;
    warn(`[matrix] refresh failed: ${err.message}`);
    cliStore.merge([config.manualClis]);
    health.cliCount = cliStore.clis.length;
    health.lastMatrixRefreshAt = new Date().toISOString(); // avoid hammering on failure
  } finally {
    matrixRefreshing = false;
  }
}

async function runCycle(lamixAccounts) {
  const accounts = Array.isArray(lamixAccounts) ? lamixAccounts.filter(Boolean) : [lamixAccounts];
  const client = accounts[0];
  const allClis = cliStore.snapshot();
  if (accounts.length === 0) {
    warn("[lamix] no client sessions available — check LAMIX_USERNAME/PASSWORD or LAMIX_ACCOUNTS");
    return { sent: 0, cycles: [], attempts: 0, failures: 0 };
  }
  if (allClis.length === 0) {
    warn("[clis] no CLIs to search yet — check Matrix login / LAMIX_CLIS");
    return { sent: 0, cycles: [], attempts: 0, failures: 0 };
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

    // Time-sensitive CLIs from Matrix (live_feed, announcements, failed_messages)
    // must be checked immediately — a 2-minute-old hit is worthless if the
    // A-Z rotation reaches that CLI an hour later. Check fresh/hot first, then
    // fill the remaining slots with a full-pool A-Z rotation.
    const early = uniqLower([...combinedFreshClis(), ...combinedHotClis()])
      .filter((c) => allClis.includes(c) && !prioritySet.has(String(c).toLowerCase()))
      .slice(0, Math.min(restPerCycle, 350));
    const earlySet = new Set(early.map((c) => String(c).toLowerCase()));
    const pool = rest.filter((c) => !earlySet.has(String(c).toLowerCase()));
    const azSlots = Math.max(0, restPerCycle - early.length);
    const totalRest = pool.length;
    const offset = totalRest ? health.cliOffset % totalRest : 0;
    const batchRest = pool.slice(offset, offset + azSlots);
    // Wrap only to the CLIs skipped before `offset`. Padding with the whole
    // pool duplicated CLIs already in batchRest (log showed e.g. 219/216).
    const remaining = azSlots - batchRest.length;
    if (remaining > 0 && offset > 0) {
      batchRest.push(...pool.slice(0, Math.min(remaining, offset)));
    }
    health.cliOffset = totalRest ? (offset + azSlots) % totalRest : 0;
    batch = [...priorityInList, ...early, ...batchRest];
    log(
      `[batch] searching ${batch.length}/${total} CLIs (Matrix fresh/hot ${early.length} + A-Z ${batchRest.length} · priority ${priorityInList.join(",") || "none"} · offset ${offset}/${totalRest})`,
    );
  } else {
    // No batching — priority first, then hot CLIs, then the rest.
    const hotRank = new Map(combinedHotClis().map((c, i) => [String(c).toLowerCase(), i]));
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
  async function checkCli(cli, account) {
    if (Date.now() > cycleDeadline) throw new Error("Cycle deadline exceeded");
    const result = await account.searchCli(cli);
    const { rows, serverNowMs } = result;
    const failed = Boolean(result?.failed);
    health.searchesDone += 1;
    health.paceMs = account.gapMs ?? health.paceMs;
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
    log(`checked "${cli}" (${account.username ?? "account"}): ${rows.length} row(s), ${alerts.length} new hit(s)` + (result.capped ? " (capped)" : ""));
    return { cli, alerts, serverNowMs, failed: Boolean(result?.failed) };
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

  const markRateLimited = (err, account) => {
    health.rateLimitHits += 1;
    health.last429At = (account?.last429At ?? new Date().toISOString());
    health.rateLimitedUntil = new Date(Date.now() + (err.retryAfterSeconds ?? 300) * 1000).toISOString();
    health.paceMs = account?.gapMs ?? health.paceMs;
    health.cooldownMs = account?.cooldownMs ?? health.cooldownMs;
    warn(`[rate-limit] ${account?.username ?? "account"}: ${err.message} — pausing until ${health.rateLimitedUntil} (pace ${account?.gapMs ?? "?"}ms, cooldown ${account?.cooldownMs ?? "?"}ms)`);
  };

  const liveAccounts = accounts.filter((account) => account.rateLimitedForSeconds === 0);
  const activeAccounts = liveAccounts.length ? liveAccounts : accounts;
  // Rotate Lark across every currently healthy session instead of permanently using one.
  const priorityClient = liveAccounts.length ? liveAccounts[(health.cycle - 1) % liveAccounts.length] : accounts[0];
  const priorityCycles = [];
  for (const cli of priorityBatch) {
    try {
      const cycle = await checkCli(cli, priorityClient);
      priorityCycles.push(cycle);
    } catch (err) {
      if (err instanceof RateLimitError) {
        markRateLimited(err, priorityClient);
      } else {
        warn(`CLI "${cli}" failed: ${err.message}`);
      }
    }
  }
  await sendAlerts(priorityCycles);

  // A-Z full-pool mode: check only the current rotated batch so every CLI in
  // the 10k+ store gets covered evenly. Matrix-sourced CLIs are stored in
  // allClis and rotate in with the rest — no hot/Lark tier gets priority.
  let sourcePool = restBatch;
  if (config.clisPerCycle <= 0) {
    const usable = (c) => !prioritySet.has(String(c).toLowerCase()) && allClis.includes(c);
    const hotPool = combinedHotClis().filter(usable).slice(0, 250);
    const hotSet = new Set(hotPool.map((c) => String(c).toLowerCase()));
    const coldPool = allClis.filter((c) => !hotSet.has(String(c).toLowerCase()));
    const useCold = hotPool.length === 0 || health.cycle % 30 === 29;
    sourcePool = useCold ? coldPool : hotPool;
  }

  const settled = await Promise.all(
    sourcePool.map(async (cli, index) => {
      const account = activeAccounts[index % activeAccounts.length];
      try {
        const cycle = await checkCli(cli, account);
        return cycle;
      } catch (err) {
        return { __error: true, cli, account, err };
      }
    }),
  );
  const cycles = [...priorityCycles];
  const errored = [];
  for (const result of settled) {
    if (result?.__error) {
      const { cli, account, err } = result;
      if (err instanceof RateLimitError) {
        markRateLimited(err, account);
      } else {
        warn(`CLI "${cli}" (${account?.username ?? "account"}) failed: ${err?.message || String(err)}`);
      }
      errored.push(account);
      continue;
    }
    cycles.push(result);
  }

  // Send the rest (priority already sent above, so only send non-priority hits now)
  const restCycles = cycles.filter((c) => !prioritySet.has(String(c.cli).toLowerCase()));
  await sendAlerts(restCycles);

  const totalSent = priorityCycles.reduce((s, c) => s + c.alerts.length, 0) + restCycles.reduce((s, c) => s + c.alerts.length, 0);
  health.lamixAccountErrors = errored.map((account) => ({
    account: account?.username ?? "unknown",
    at: new Date().toISOString(),
  }));
  return {
    sent: totalSent,
    cycles,
    attempts: cycles.length + errored.length,
    failures: cycles.filter((c) => c.failed).length + errored.length,
  };
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
        matrixHotClis: matrixHotClis.length,
        matrixFreshClis: matrixFreshClis.length,
        lamixAccountErrors: health.lamixAccountErrors,
        signalHotClis: signalHotClis.length,
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
  log(`starting Lamix CLI bot | CLIs source: ${[
    config.matrix.enabled ? "Matrix" : null,
    config.signal.enabled ? "SignalPulse" : null,
    "manual",
  ].filter(Boolean).join(" + ")}`);
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
  if (process.env.TELEGRAM_COMMANDS_ENABLED !== "false") {
    startTelegramCommandPolling({ token: config.telegram.token, logger });
  } else {
    log("[telegram] command polling disabled (/myid helper not required)");
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

  const lamixAccounts = [lamix];
  for (const account of config.extraLamixAccounts ?? []) {
    if (!account.username || !account.password) continue;
    lamixAccounts.push(
      new LamixClient({
        baseUrl: config.lamix.baseUrl,
        username: account.username,
        password: account.password,
        headless: config.headless,
        logger,
        priorityClis: config.priorityClis,
        searchPacingMs: config.searchPacingMs,
        searchTimeoutMs: config.searchTimeoutMs,
        priorityTimeoutMs: config.priorityTimeoutMs,
      }),
    );
  }

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

  // Start every Lamix session independently; one failed account must not block the others.
  // Stagger logins: six simultaneous page loads made the panel serve a slow
  // challenge page and every account timed out. Start one account at a time.
  const startResults = [];
  for (let i = 0; i < lamixAccounts.length; i += 1) {
    startResults.push(await Promise.allSettled([lamixAccounts[i].start()]).then((r) => r[0]));
    if (i < lamixAccounts.length - 1) await sleep(1500);
  }
  let workingLamixAccounts = lamixAccounts.filter((_, index) => startResults[index]?.status === "fulfilled");
  startResults.forEach((result, index) => {
    const rel = lamixAccounts[index];
    if (result.status === "fulfilled") {
      log(`[lamix] account "${rel.username}" ready`);
    } else {
      warn(`[lamix] account "${rel.username}" failed to start: ${result.reason?.message || String(result.reason)}`);
    }
  });

  if (workingLamixAccounts.length === 0) {
    console.error("[fatal] Lamix failed after all attempts, starting health-only mode (alerts paused, ping continues)");
  }

  // Watchdog + auto-recovery: never stay dead.
  let running = true;
  let restartRequested = false;
  let fatalStreak = 0;
  const restartAllLamix = () => Promise.allSettled(lamixAccounts.map((account) => account.restart()));
  const shutdown = async (signal) => {
    if (!running) return;
    running = false;
    log(`received ${signal}, shutting down`);
    server?.close();
    await Promise.allSettled(lamixAccounts.map((account) => account.stop()));
    await matrix?.stop().catch(() => {});
    await closeSharedBrowser();
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

  // Initial Matrix harvest blocks the first Lamix cycle so searches use live
  // fresh/hot CLIs instead of the stale cold pool.
  if (matrix) {
    await refreshMatrixIfNeeded(matrix, true).catch((e) => warn(`[matrix] initial refresh failed: ${e.message}`));
  } else cliStore.merge([config.manualClis]);
  if (signal) {
    refreshSignalIfNeeded(signal, true).catch((e) => warn(`[signal] initial refresh failed: ${e.message}`));
  }

  if (config.scanOnce) {
    log(`[scan-once] CLIs saved: ${cliStore.clis.length} -> ${config.cliFile}`);
    console.log(JSON.stringify(cliStore.snapshot(), null, 2));
    await Promise.allSettled(lamixAccounts.map((account) => account.stop()));
    await matrix?.stop().catch(() => {});
    await closeSharedBrowser();
    server?.close();
    return;
  }

  const activeLamixAccounts = () => workingLamixAccounts;

  // Retry any account that failed its initial login. Without this, one slow
  // page load permanently removes that account from the search pool.
  let accountRetryInFlight = false;
  const retryFailedAccounts = async () => {
    if (accountRetryInFlight || workingLamixAccounts.length === lamixAccounts.length) return;
    accountRetryInFlight = true;
    try {
      for (const account of lamixAccounts) {
        if (workingLamixAccounts.includes(account)) continue;
        try {
          await account.start();
          workingLamixAccounts.push(account);
          log(`[lamix] account "${account.username}" recovered and joined the search pool`);
        } catch (err) {
          warn(`[lamix] account "${account.username}" retry failed: ${err.message}`);
        }
      }
    } finally {
      accountRetryInFlight = false;
    }
  };

  while (running) {
    const startedAt = Date.now();
    health.cycle += 1;
    health.lastCycleAt = new Date().toISOString();
    try {
      if (restartRequested) {
        await restartAllLamix();
        health.lamixRestarts += 1;
        restartRequested = false;
      }
      // Watchdog: never run a cycle with zero ready accounts — that used to
      // trigger a rebuild storm (every CLI fails -> rebuild -> fail again).
      if (workingLamixAccounts.length === 0) {
        warn("[watchdog] no ready Lamix accounts — retrying logins, searches paused");
        await retryFailedAccounts();
        if (workingLamixAccounts.length === 0) {
          await sleep(15000);
          continue;
        }
      } else {
        void retryFailedAccounts();
      }
      if (matrix) await refreshMatrixIfNeeded(matrix, false);
      // SignalPulse refresh is HTTP-only; run it in the background so a slow
      // download never delays Lamix searches (hot list updates atomically).
      if (signal) refreshSignalIfNeeded(signal, false).catch((e) => warn(`[signal] refresh failed: ${e.message}`));
      const cycleResult = await runCycle(activeLamixAccounts());
      if (cycleResult.attempts > 0 && cycleResult.failures === cycleResult.attempts) {
        health.lastError = "Lamix browser/session is not responding — every CLI failed in this cycle";
        health.consecutiveFailures += 1;
        fatalStreak += 1;
        warn(`[lamix] ${fatalStreak} consecutive stalled cycle(s) — health endpoint will report degraded`);
        if (fatalStreak >= 2) {
          warn("[watchdog] rebuilding Lamix browser/session after stalled searches");
          const rebuilt = await Promise.allSettled(workingLamixAccounts.map((account) => account.recreateSession()));
          if (rebuilt.some((result) => result.status === "fulfilled")) {
            health.lamixRestarts += 1;
            fatalStreak = 0;
          }
        }
      } else {
        health.lastSuccessAt = new Date().toISOString();
        health.lastError = null;
        health.consecutiveFailures = 0;
        fatalStreak = 0;
      }
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
        await restartAllLamix().catch((e) => warn(`lamix restart failed: ${e.message}`));
        health.lamixRestarts += 1;
        restartRequested = false;
      }
    }
    if (state.prune(Date.now()) > 0) state.save();
    if (config.once) break;
    const elapsed = Date.now() - startedAt;
    // Smooth pacing between cycles + honor 429 cool-down per account. Do not pause healthy sessions.
    const waitMs = Math.max(5000, config.pollSeconds * 1000 - elapsed);
    await sleep(Math.min(waitMs, 10 * 60 * 1000));
  }
  await Promise.allSettled(lamixAccounts.map((account) => account.stop()));
  await matrix?.stop().catch(() => {});
  await closeSharedBrowser();
  server?.close();
  log("stopped");
}

main().catch((err) => { console.error(`[fatal] ${err.stack || err.message}`); process.exit(1); });
