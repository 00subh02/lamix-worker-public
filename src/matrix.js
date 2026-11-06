import { chromium } from "playwright";
import { cleanCliList } from "./clis.js";

/**
 * MatrixPanel CLI harvester.
 *
 * Uses a real Chromium session (same technique as Lamix) so the panel's
 * auth cookies are honoured. Data is fetched via the panel's own APIs:
 *   - GET /api/live_feed?limit=500                  -> clis[].cli
 *   - GET /api/announcements                         -> "NEW LAMIX APP: <CLI>"
 *   - GET /api/failed_messages?...&limit=500         -> rows[].from
 */
export class MatrixClient {
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
    if (!this.username || !this.password) {
      throw new Error("MATRIX_USERNAME / MATRIX_PASSWORD required for Matrix harvest");
    }
    this.logger.info(`[matrix] launching Chromium -> ${this.baseUrl}`);
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
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  isOnLogin() {
    try { return new URL(this.page.url()).pathname.includes("/login"); } catch { return true; }
  }

  async login() {
    const page = this.page;
    this.logger.info("[matrix] opening login page");
    await page.goto(`${this.baseUrl}/auth/login`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    if (!this.isOnLogin()) {
      this.logger.info("[matrix] session already active");
      return;
    }
    const inputs = page.locator("input");
    await inputs.first().waitFor({ state: "visible", timeout: 30000 });
    await inputs.nth(0).fill(this.username);
    await inputs.nth(1).fill(this.password);
    const signIn = page.getByRole("button", { name: /sign in/i }).first();
    await signIn.click();
    try {
      await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45000 });
    } catch {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`Matrix login failed for "${this.username}": ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    this.logger.info(`[matrix] logged in (${page.url()})`);
  }

  async ensureSession() {
    if (this.isOnLogin()) await this.login();
    // Touch a lightweight endpoint to detect expired session
    try {
      await this.page.goto(`${this.baseUrl}/auth/live-feed`, { waitUntil: "domcontentloaded" });
      if (this.isOnLogin()) {
        this.logger.info("[matrix] session expired, re-logging in");
        await this.login();
      }
    } catch {}
  }

  /** Fetch JSON via the page (same-origin, cookies included). */
  async fetchJson(path) {
    return this.page.evaluate(async (p) => {
      const res = await fetch(p, { credentials: "same-origin" });
      const text = await res.text();
      return { status: res.status, text };
    }, path);
  }

  async harvest() {
    await this.ensureSession();

    const results = { liveFeed: [], announcements: [], failed: [], meta: {} };

    // 1) Live feed
    try {
      const r = await this.fetchJson("/api/live_feed?limit=500");
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        results.liveFeed = (j.clis || []).map((c) => c.cli);
        results.meta.liveFeed = {
          total: j.total_clis,
          dbClis: j.total_db_clis,
          dbMessages: j.total_db_messages,
          returned: results.liveFeed.length,
        };
        this.logger.info(`[matrix] live_feed: ${results.liveFeed.length} CLIs (db total ${j.total_db_clis})`);
      } else {
        this.logger.warn(`[matrix] live_feed HTTP ${r.status}: ${r.text.slice(0, 120)}`);
        if (r.status >= 400 && r.status < 500) await this.reloginAndRetry();
      }
    } catch (err) {
      this.logger.warn(`[matrix] live_feed failed: ${err.message}`);
    }

    // 2) Announcements (new-app announcements "NEW LAMIX APP: <CLI>")
    try {
      const r = await this.fetchJson("/api/announcements");
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const list = (j.announcements || []).map((a) => {
          const m = String(a.message || "").match(/NEW LAMIX APP:\s*(.+)/);
          return m ? m[1].split("\n")[0].trim() : null;
        }).filter(Boolean);
        results.announcements = list;
        results.meta.announcements = { returned: list.length };
        this.logger.info(`[matrix] announcements: ${list.length} CLIs`);
      } else {
        this.logger.warn(`[matrix] announcements HTTP ${r.status}`);
      }
    } catch (err) {
      this.logger.warn(`[matrix] announcements failed: ${err.message}`);
    }

    // 3) Failed messages (sender CLI in rows[].from) - last 12h, 500 rows
    try {
      const today = new Date();
      const from = new Date(today.getTime() - 12 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
      const url = `/api/failed_messages?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(today))}&limit=500&offset=0`;
      const r = await this.fetchJson(url);
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const list = (j.rows || []).map((x) => x.from);
        results.failed = list;
        results.meta.failed = { total: j.total, returned: list.length };
        this.logger.info(`[matrix] failed_messages: ${new Set(list).size} distinct CLIs (${j.total} total)`);
      } else {
        this.logger.warn(`[matrix] failed_messages HTTP ${r.status}`);
      }
    } catch (err) {
      this.logger.warn(`[matrix] failed_messages failed: ${err.message}`);
    }

    results.all = cleanCliList([...results.liveFeed, ...results.announcements, ...results.failed]);
    return results;
  }

  async reloginAndRetry() {
    try {
      await this.login();
    } catch {}
  }
}
