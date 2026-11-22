function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env: ${name}`);
  return v.trim();
}
function optional(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}
function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}: "${raw}" (must be ${min}..${max})`);
  return n;
}
function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
function parseClis(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseAccounts(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(",")) {
    const pair = part.trim();
    const idx = pair.indexOf(":");
    if (idx <= 0 || idx === pair.length - 1) continue;
    const username = pair.slice(0, idx).trim();
    const password = pair.slice(idx + 1).trim();
    if (username && password) out.push({ username, password });
  }
  return out;
}

// Stable FNV-1a shard. Every worker derives the SAME owner for a CLI, so with
// N workers each CLI is checked by exactly one of them — no duplicate alerts
// even though every worker sends to the same Telegram group.
export function shardFor(value, total) {
  if (!total || total <= 1) return 0;
  const s = String(value ?? "").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % total;
}

export function loadConfig() {
  const manualClis = parseClis(process.env.LAMIX_CLIS || process.env.LAMIX_CLI || "");

  const matrixEnabled = bool("MATRIX_ENABLED", true);
  const windows = bool("MATRIX_ENABLED", true) ? manualClis : manualClis;

  const matrixUrl = optional("MATRIX_BASE_URL", "https://matrixpanel.io").replace(/\/+$/, "");
  const matrixUsername = optional("MATRIX_USERNAME", "");
  const matrixPassword = optional("MATRIX_PASSWORD", "");

  // Lamix
  const lamixUrl = optional("LAMIX_BASE_URL", "https://panel.lamix.org").replace(/\/+$/, "");
  const lamixUsername = optional("LAMIX_USERNAME", "");
  const lamixPassword = optional("LAMIX_PASSWORD", "");
  if (!lamixUsername || !lamixPassword) throw new Error("Missing LAMIX_USERNAME / LAMIX_PASSWORD");

  const telegramToken = required("TELEGRAM_BOT_TOKEN");
  // Supports comma-separated chat ids for multi-group broadcast (e.g. "-100aaa,-100bbb")
  const telegramChatIds = parseClis(process.env.TELEGRAM_CHAT_ID || "");
  // Backward compat: also accept TELEGRAM_CHAT_IDS plural
  const telegramChatIdsPlural = parseClis(process.env.TELEGRAM_CHAT_IDS || "");
  const allChatIds = [...new Set([...telegramChatIds, ...telegramChatIdsPlural])];
  const telegramChatId = allChatIds[0] || null;

  // Premium custom emoji IDs used in alert headers. Defaults match the
  // reference alert (🆕 + 🎤🎤🎤). Override via env if a different pack is wanted.
  const alertEmoji = {
    new: optional("ALERT_EMOJI_NEW", "5382357040008021292"),
    mic: optional("ALERT_EMOJI_MIC", "5778673721317267508"),
  };

  const cliFile = optional("CLI_FILE", "./data/clis.json");
  const maxClis = int("MAX_CLIS", 0, { min: 0 }); // 0 = unlimited
  const clisPerCycle = int("CLIS_PER_CYCLE", 12, { min: 0 }); // 0 = all each cycle
  const matrixRefreshMinutes = int("MATRIX_REFRESH_MINUTES", 60, { min: 1, max: 1440 });
  // Empty PRIORITY_CLIS intentionally disables priority — users can prioritize a CLI via LAMIX_CLIS too.
  const priorityClis =
    process.env.PRIORITY_CLIS !== undefined
      ? parseClis(process.env.PRIORITY_CLIS)
      : parseClis(process.env.LAMIX_CLIS || "");
  const extraLamixAccounts = parseAccounts(process.env.LAMIX_ACCOUNTS || "");
  const searchWindowHours = int("SEARCH_WINDOW_HOURS", 24, { min: 1, max: 168 });

  // Lamix pacing / rate-limit guard
  const searchPacingMs = int("SEARCH_PACING_MS", 4000, { min: 400, max: 60000 });
  const searchTimeoutMs = int("LAMIX_SEARCH_TIMEOUT_MS", 10000, { min: 3000, max: 60000 });
  const priorityTimeoutMs = int("LAMIX_PRIORITY_TIMEOUT_MS", 20000, { min: 3000, max: 120000 });
  const cycleSeconds = int("CYCLE_SECONDS", 300, { min: 15, max: 600 });

  // SignalPulse source (fast, no browser) — refreshed independently if enabled
  const signalEnabled = bool("SIGNAL_ENABLED", true);
  const signalUrl = optional("SIGNAL_BASE_URL", "http://201.18.218.200:8080").replace(/\/+$/, "");
  const signalRefreshMinutes = int("SIGNAL_REFRESH_MINUTES", 5, { min: 1, max: 1440 });

  const selfPingUrl = optional("SELF_PING_URL", "");
  // Allow multiple URLs (comma-separated) for unlimited keep-alive redundancy
  const selfPingUrls = selfPingUrl ? selfPingUrl.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const selfPingMinutes = int("SELF_PING_MINUTES", 2, { min: 1, max: 60 });
  const selfPingEnabled = bool("SELF_PING_ENABLED", true) && selfPingUrls.length > 0;

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : null;

  // Multi-worker sharding. WORKER_TOTAL=1 keeps the old single-bot behaviour.
  const workerTotal = int("WORKER_TOTAL", 1, { min: 1, max: 64 });
  const workerId = int("WORKER_ID", 0, { min: 0, max: workerTotal - 1 });

  return {
    worker: { id: workerId, total: workerTotal },
    lamix: { baseUrl: lamixUrl, username: lamixUsername, password: lamixPassword },
    extraLamixAccounts,
    matrix: {
      enabled: matrixEnabled,
      baseUrl: matrixUrl,
      username: matrixUsername,
      password: matrixPassword,
      refreshMinutes: matrixRefreshMinutes,
    },
    signal: {
      enabled: signalEnabled,
      baseUrl: signalUrl,
      refreshMinutes: signalRefreshMinutes,
    },
    telegram: { token: telegramToken, chatId: telegramChatId, chatIds: allChatIds },
    alertEmoji,
    manualClis,
    priorityClis,
    cliFile,
    maxClis,
    clisPerCycle,
    searchPacingMs,
    searchTimeoutMs,
    priorityTimeoutMs,
    cycleSeconds,
    pollSeconds: int("POLL_SECONDS", 10, { min: 10 }),
    windowMinutes: int("WINDOW_MINUTES", 5, { min: 1, max: 1440 }),
    rangeCooldownMinutes: int("RANGE_COOLDOWN_MINUTES", 10, { min: 0, max: 1440 }),
    futureSkewSeconds: int("FUTURE_SKEW_SECONDS", 30, { min: 0 }),
    stateFile: optional("STATE_FILE", "./data/state.json"),
    headless: bool("HEADLESS", true),
    dryRun: bool("DRY_RUN", false),
    once: process.argv.includes("--once"),
    scanOnce: process.argv.includes("--scan-once"),
    port,
    selfPing: { url: selfPingUrls[0] || null, urls: selfPingUrls, minutes: selfPingMinutes, enabled: selfPingEnabled },
    searchWindowHours,
  };
}
