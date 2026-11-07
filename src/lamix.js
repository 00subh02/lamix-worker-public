import { chromium } from "playwright";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LamixClient {
  constructor({ baseUrl, username, password, headless = true, logger = console }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.headless = headless;
    this.logger = logger;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    this.logger.info("[lamix] launching Chromium");
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    await this.login();
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
    await page.goto(`${this.baseUrl}/login`, { waitUntil: "domcontentloaded" });
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
    if (page.url().includes("/cli-search") && !this.isOnLoginPage()) return;

    await page.goto(`${this.baseUrl}/cli-search`, { waitUntil: "commit", timeout: 45000 });
    if (this.isOnLoginPage()) {
      throw new AuthError("Session expired while opening CLI Search (redirected to login).");
    }
    await page
      .locator('input[placeholder*="full sender" i]')
      .waitFor({ state: "visible", timeout: 30000 });
  }

  /**
   * Runs one CLI Search through the panel UI and returns the JSON payload the
   * panel itself received. Driving the UI means the panel's own request signing
   * stays intact; we never re-implement or bypass it.
   * Handles Lamix rate-limit (429) with exponential backoff.
   */
  async searchCli(cli) {
    const page = this.page;
    try {
      await this.gotoCliSearch();
    } catch (err) {
      if (String(err).includes("/cli-search")) throw err;
      await this.gotoCliSearch();
    }

    const input = page.locator('input[placeholder*="full sender" i]').first();
    await input.fill(cli);

    let lastError = null;
    // Priority CLIs get a longer timeout (Lark must never miss), rest get fast 12s
    const isPriority = ["lark"].includes(String(cli).toLowerCase());
    const timeoutMs = isPriority ? 30000 : 12000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/cli-search") && response.request().method() === "GET",
        { timeout: timeoutMs },
      );

      const searchButton = page
        .locator("button")
        .filter({ hasText: /^\s*search\s*$/i })
        .first();
      await searchButton.click().catch(() => {});

      const response = await responsePromise.catch((e) => {
        lastError = e;
        this.logger.warn(`[lamix] timeout on CLI "${cli}" attempt ${attempt}/3 (${Math.round(timeoutMs / 1000)}s)`);
        return null;
      });
      if (!response) continue;
      const status = response.status();
      if (status === 429) {
        // Fast-skip 429 — don't wait 30s, retry once after short 3s
        this.logger.warn(`[lamix] rate-limited (429) on CLI "${cli}", attempt ${attempt}/3 — waiting 3s`);
        await sleep(3000);
        lastError = new Error("CLI search rate-limited (429)");
        try { await response.text().catch(() => {}); } catch {}
        continue;
      }
      if (status === 401 || status === 403) {
        const text = await response.text().catch(() => "");
        throw new AuthError(`CLI search rejected (${status}) for "${cli}": ${text.slice(0, 200)}`);
      }
      if (status >= 400) {
        throw new Error(`CLI search for "${cli}" failed with HTTP ${status}`);
      }

      const data = await response.json().catch(() => ({ rows: [] }));
      const headerNow = Number(response.headers()["x-server-time"]);
      const dateNow = Date.parse(response.headers()["date"] || "");
      const serverNowMs = Number.isFinite(headerNow) && headerNow > 0 ? headerNow : Number.isFinite(dateNow) ? dateNow : Date.now();

      // Gentle pacing — 1500ms balance (1000 too fast -> 429 storm, 2000 too slow)
      await sleep(1500);

      return {
        cli,
        rows: Array.isArray(data.rows) ? data.rows : [],
        windowHours: data.windowHours,
        capped: Boolean(data.capped),
        serverNowMs,
      };
    }
    // Never throw on timeout/429 after retries — return empty so cycle continues (never die)
    this.logger.warn(`[lamix] CLI "${cli}" gave up after retries, returning empty`);
    return {
      cli,
      rows: [],
      windowHours: 24,
      capped: false,
      serverNowMs: Date.now(),
    };
  }
}

export { sleep };
