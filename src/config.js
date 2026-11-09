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

  const cliFile = optional("CLI_FILE", "./data/clis.json");
  const maxClis = int("MAX_CLIS", 0, { min: 0 }); // 0 = unlimited
  const clisPerCycle = int("CLIS_PER_CYCLE", 25, { min: 0 }); // 0 = all each cycle
  const matrixRefreshMinutes = int("MATRIX_REFRESH_MINUTES", 60, { min: 1, max: 1440 });
  const priorityClis = parseClis(process.env.PRIORITY_CLIS || "Lark");
  const searchWindowHours = int("SEARCH_WINDOW_HOURS", 24, { min: 1, max: 168 });

  // Lamix pacing / rate-limit guard
  const searchPacingMs = int("SEARCH_PACING_MS", 1500, { min: 400, max: 60000 });
  const searchTimeoutMs = int("LAMIX_SEARCH_TIMEOUT_MS", 10000, { min: 3000, max: 60000 });
  const priorityTimeoutMs = int("LAMIX_PRIORITY_TIMEOUT_MS", 20000, { min: 3000, max: 120000 });
  const cycleSeconds = int("CYCLE_SECONDS", 75, { min: 15, max: 600 });

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

  return {
    lamix: { baseUrl: lamixUrl, username: lamixUsername, password: lamixPassword },
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
