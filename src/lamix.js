import { chromium } from "playwright";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LamixClient {
  constructor({
    baseUrl,
    username,
    password,
    headless = true,
    logger = console,
    priorityClis = [],
    searchPacingMs = 1500,
    searchTimeoutMs = 10000,
    priorityTimeoutMs = 20000,
  }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.headless = headless;
    this.logger = logger;
    this.prioritySet = new Set((priorityClis || []).map((c) => String(c).trim().toLowerCase()));
    this.minGapMs = Math.max(1200, Math.round(searchPacingMs / 3));
    this.maxGapMs = 90000;
    this.gapMs = Math.max(this.minGapMs, searchPacingMs);
    this.nextSearchAt = 0;
    this.successStreak = 0;
    // Cool-down probing: the panel sends retry-after:300 but recovers earlier.
    // Start gentle, double on repeated 429s, reset after a good streak.
    this.cooldownMs = 60000;
    this.maxCooldownMs = 300000;
    this.searchTimeoutMs = Math.max(3000, searchTimeoutMs);
    this.priorityTimeoutMs = Math.max(this.searchTimeoutMs, priorityTimeoutMs);
    this.browser = null;
    this.context = null;
    this.page = null;
    // Rate-limit governor — shared across all searches.
    this.blockedUntil = 0;
    this.rateLimitHits = 0;
    this.searchCount = 0;
    this.lastSearchAt = 0;
    this.last429At = null;
    this.last429RetrySeconds = null;
    this.sessionStartedAt = Date.now();
  }

  get rateLimitedForSeconds() {
    const left = this.blockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  async start() {
    this.logger.info("[lamix] launching Chromium");
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    // Fail fast — every step that matters has its own explicit timeout.
    this.page.setDefaultTimeout(10000);
    await this.login();
    await this.gotoCliSearch();
    this.sessionStartedAt = Date.now();
  }

  async stop() {
    try {
      await this.context?.close();
    } catch {}
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  isOnLoginPage() {
    try {
      return new URL(this.page.url()).pathname.startsWith("/login");
    } catch {
      return true;
    }
  }

  async login() {
    const page = this.page;
    this.logger.info("[lamix] opening login page");
    await page.goto(`${this.baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    // If a valid session already exists, the app redirects away from /login.
    if (!this.isOnLoginPage()) {
      this.logger.info(`[lamix] session already active (${page.url()})`);
      return;
    }

    const inputs = page.locator("input");
    await inputs.first().waitFor({ state: "visible", timeout: 30000 });
    await inputs.nth(0).fill(this.username);
    const passwordInput = page.locator('input[type="password"]');
    if ((await passwordInput.count()) > 0) {
      await passwordInput.first().fill(this.password);
    } else {
      await inputs.nth(1).fill(this.password);
    }

    const loginButton = page.getByRole("button", { name: /log\s*in/i }).first();
    await loginButton.click();

    try {
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45000 });
    } catch {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new AuthError(
        `Login failed for "${this.username}". The panel stayed on the login page. ` +
          `Page text: ${body.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }

    this.logger.info(`[lamix] logged in (${page.url()})`);
  }

  async gotoCliSearch() {
    const page = this.page;
    if (page.url().includes("/cli-search") && !this.isOnLoginPage()) {
      // Already there — make sure the sender input is mounted.
      const visible = await page
        .locator('input[placeholder*="full sender" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return;
    }

    await page.goto(`${this.baseUrl}/cli-search`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (this.isOnLoginPage()) {
      throw new AuthError("Session expired while opening CLI Search (redirected to login).");
    }
    await page
      .locator('input[placeholder*="full sender" i]')
      .first()
      .waitFor({ state: "visible", timeout: 30000 });
  }

  async recreateSession() {
    // Lamix frequently leaves its SPA on a blank page after a session expires.
    // Rebuild only the browser/context/page and keep every rate-governor value.
    await this.stop();
    this.logger.warn("[lamix] CLI Search unavailable — rebuilding browser session and re-authenticating");
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10000);
    await this.login();
    await this.gotoCliSearch();
    this.sessionStartedAt = Date.now();
  }

  async recoverPage() {
    try {
      this.logger.warn("[lamix] recovering CLI Search page");
      await this.page.goto(`${this.baseUrl}/cli-search`, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (this.isOnLoginPage()) throw new AuthError("Session expired (redirected to login).");
      await this.page
        .locator('input[placeholder*="full sender" i]')
        .first()
        .waitFor({ state: "visible", timeout: 15000 });
    } catch (err) {
      this.logger.warn(`[lamix] recover failed: ${err.message}`);
      try {
        await this.recreateSession();
      } catch (reauthErr) {
        this.logger.warn(`[lamix] re-authentication also failed: ${reauthErr.message}`);
        throw reauthErr;
      }
    }
  }

  async pace() {
    const now = Date.now();
    const wait = this.nextSearchAt - now;
    if (wait > 0) await sleep(wait);
    this.nextSearchAt = Math.max(now, this.nextSearchAt) + this.gapMs;
    this.lastSearchAt = Date.now();
  }

  /** Self-tuning rate governor: slow down on 429, speed up carefully on success. */
  noteRateLimit(retryAfter) {
    this.rateLimitHits += 1;
    this.last429At = new Date().toISOString();
    this.last429RetrySeconds = retryAfter;
    const waitMs = Math.min(this.maxCooldownMs, Math.max(this.cooldownMs, 30000));
    this.blockedUntil = Date.now() + waitMs;
    this.nextSearchAt = this.blockedUntil;
    this.cooldownMs = Math.min(this.maxCooldownMs, Math.round(this.cooldownMs * 1.8));
    this.gapMs = Math.min(this.maxGapMs, Math.max(8000, Math.round(this.gapMs * 1.6)));
    this.successStreak = 0;
    this.lastCooldownMs = waitMs;
  }

  noteSuccess() {
    this.successStreak += 1;
    if (this.successStreak >= 8) {
      this.successStreak = 0;
      this.cooldownMs = Math.max(45000, Math.round(this.cooldownMs * 0.7));
      this.gapMs = Math.max(this.minGapMs, Math.round(this.gapMs * 0.9));
    }
  }

  parseRetryAfter(response) {
    const h = response.headers();
    const raw = h["retry-after"];
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return Math.min(900, Math.max(30, n));
      const when = Date.parse(raw);
      if (Number.isFinite(when)) return Math.min(900, Math.max(30, Math.ceil((when - Date.now()) / 1000)));
    }
    return 300;
  }

  /**
   * Runs one CLI Search through the panel UI and returns the JSON payload the
   * panel itself received. Driving the UI means the panel's own request signing
   * stays intact; we never re-implement or bypass it.
   *
   * The Search button is disabled until the form is valid, so we submit the
   * form with Enter (what the UI itself does) instead of clicking.
   */
  async searchCli(cli) {
    if (this.rateLimitedForSeconds > 0) {
      throw new RateLimitError(
        `Lamix rate limit active — ${this.rateLimitedForSeconds}s left`,
        this.rateLimitedForSeconds,
      );
    }

    const isPriority = this.prioritySet.has(String(cli).trim().toLowerCase());
    const timeoutMs = isPriority ? this.priorityTimeoutMs : this.searchTimeoutMs;
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.rateLimitedForSeconds > 0) {
        throw new RateLimitError(
          `Lamix rate limit active — ${this.rateLimitedForSeconds}s left`,
          this.rateLimitedForSeconds,
        );
      }

      try {
        await this.gotoCliSearch();
      } catch (err) {
        if (err instanceof AuthError) throw err;
        await this.recoverPage();
      }

      // Wait out the adaptive gap *before* firing the request.
      await this.pace();

      const input = this.page.locator('input[placeholder*="full sender" i]').first();
      await input.waitFor({ state: "visible", timeout: 10000 });

      const responsePromise = this.page
        .waitForResponse(
          (response) =>
            response.url().includes("/api/cli-search") && response.request().method() === "GET",
          { timeout: timeoutMs },
        )
        .catch((err) => ({ __error: err }));

      // Enter submits the panel's own GET form — the same request the UI makes.
      await input.fill(cli);
      await input.press("Enter");

      const response = await responsePromise;
      if (response.__error) {
        lastError = response.__error;
        this.logger.warn(
          `[lamix] no response for "${cli}" attempt ${attempt}/${maxAttempts} (${Math.round(timeoutMs / 1000)}s)`,
        );
        if (attempt < maxAttempts) {
          await this.recoverPage().catch(() => {});
          await sleep(800);
        }
        continue;
      }

      const status = response.status();
      if (status === 429) {
        const retryAfter = this.parseRetryAfter(response);
        await response.text().catch(() => {});
        this.noteRateLimit(retryAfter);
        this.logger.warn(
          `[lamix] 429 rate-limited — pausing ${this.rateLimitedForSeconds}s, pace now ${this.gapMs}ms`,
        );
        throw new RateLimitError(
          `Lamix rate-limited (429) — cool down ${this.rateLimitedForSeconds}s`,
          this.rateLimitedForSeconds,
        );
      }

      if (status === 401 || status === 403) {
        const text = await response.text().catch(() => "");
        throw new AuthError(`CLI search rejected (${status}) for "${cli}": ${text.slice(0, 200)}`);
      }

      if (status >= 400) {
        lastError = new Error(`CLI search for "${cli}" failed with HTTP ${status}`);
        this.logger.warn(`[lamix] ${lastError.message} attempt ${attempt}/${maxAttempts}`);
        if (attempt < maxAttempts) {
          await this.recoverPage().catch(() => {});
          await sleep(800);
        }
        continue;
      }

      const data = await response.json().catch(() => ({ rows: [] }));
      const headerNow = Number(response.headers()["x-server-time"]);
      const dateNow = Date.parse(response.headers()["date"] || "");
      const serverNowMs =
        Number.isFinite(headerNow) && headerNow > 0
          ? headerNow
          : Number.isFinite(dateNow)
            ? dateNow
            : Date.now();

      this.searchCount += 1;
      this.noteSuccess();

      return {
        cli,
        rows: Array.isArray(data.rows) ? data.rows : [],
        windowHours: data.windowHours,
        capped: Boolean(data.capped),
        serverNowMs,
      };
    }

    // Never throw on timeout after retries — return empty so the cycle continues.
    this.logger.warn(`[lamix] CLI "${cli}" gave up after retries — returning empty`);
    return {
      cli,
      rows: [],
      windowHours: 24,
      capped: false,
      serverNowMs: Date.now(),
      failed: true,
      error: lastError?.message ?? "timeout",
    };
  }
}

export { sleep };
