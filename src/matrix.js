import { getSharedBrowser, createLowMemoryContext } from "./lamix.js";
import { cleanCliList, cleanOrderedCliList } from "./clis.js";

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
    this.logger.info(`[matrix] opening session (shared Chromium) -> ${this.baseUrl}`);
    this.browser = await getSharedBrowser(this.headless);
    this.context = await createLowMemoryContext(this.browser);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    await this.login();
  }

  async stop() {
    try { await this.context?.close(); } catch {}
    // Shared Chromium is closed once at process shutdown by bot.js.
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
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      if (this.isOnLogin()) {
        this.logger.info("[matrix] session expired, re-logging in");
        await this.login();
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
    } catch {}
  }

  /** Fetch JSON via the page (same-origin, cookies included) with one retry for SPA navigations. */
  async fetchJson(path) {
    const value = await this.page.evaluate(async (p) => {
      const res = await fetch(p, { credentials: "same-origin" });
      const text = await res.text();
      return { status: res.status, text };
    }, path).catch(async (err) => {
      if (!/Execution context was destroyed|navigation/i.test(err?.message || "")) throw err;
      await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return this.page.evaluate(async (p) => {
        const res = await fetch(p, { credentials: "same-origin" });
        const text = await res.text();
        return { status: res.status, text };
      }, path);
    });
    return value;
  }

  static timeToMs(value) {
    if (!value) return null;
    const raw = String(value).trim();
    // RFC-style dates such as "Sat, 14 Nov 2026 15:08:10 GMT" parse directly.
    if (raw.includes(" GMT") || raw.includes("Z") || raw.includes("T")) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return ms;
    }
    // Matrix also returns "YYYY-MM-DD HH:MM:SS UTC".
    const normalized = raw.replace(/\s+UTC$/i, "Z").replace(" ", "T");
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
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
    const announcementRows = [];
    try {
      const r = await this.fetchJson("/api/announcements");
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const list = [];
        for (const a of j.announcements || []) {
          const m = String(a.message || "").match(/NEW LAMIX APP:\s*(.+)/);
          const cli = m ? m[1].split("\n")[0].trim() : null;
          if (!cli) continue;
          const ts = MatrixClient.timeToMs(a.created_at);
          announcementRows.push({ cli, ts });
          list.push(cli);
        }
        results.announcements = list;
        results.meta.announcements = { returned: list.length };
        this.logger.info(`[matrix] announcements: ${list.length} CLIs`);
      } else {
        this.logger.warn(`[matrix] announcements HTTP ${r.status}`);
      }
    } catch (err) {
      this.logger.warn(`[matrix] announcements failed: ${err.message}`);
    }

    // 3) Failed messages (sender CLI in rows[].from) - last 12h, recent traffic wins
    const failedCounts = new Map();
    try {
      const today = new Date();
      const from = new Date(today.getTime() - 12 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
      const url = `/api/failed_messages?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(today))}&limit=1000&offset=0`;
      const r = await this.fetchJson(url);
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        const list = (j.rows || []).map((x) => {
          const cli = x.from;
          const ts = MatrixClient.timeToMs(x.time ?? x.created_at ?? x.updated_at);
          if (cli) {
            const key = String(cli).trim();
            const prev = failedCounts.get(key) ?? { cli: key, count: 0, lastMs: 0 };
            prev.count += 1;
            prev.lastMs = Math.max(prev.lastMs || 0, ts || 0);
            failedCounts.set(key, prev);
          }
          return cli;
        });
        results.failed = list;
        results.meta.failed = { total: j.total, returned: list.length };
        this.logger.info(`[matrix] failed_messages: ${failedCounts.size} distinct CLIs (${j.total} total)`);
      } else {
        this.logger.warn(`[matrix] failed_messages HTTP ${r.status}`);
      }
    } catch (err) {
      this.logger.warn(`[matrix] failed_messages failed: ${err.message}`);
    }

    const nowMs = Date.now();
    const announcementLatest = new Map();
    for (const row of announcementRows) {
      const key = String(row.cli).trim();
      if (!key) continue;
      announcementLatest.set(key, Math.max(announcementLatest.get(key) || 0, row.ts || 0));
    }

    const failedRanked = [...failedCounts.values()]
      .map((row) => ({ ...row, failedAgeMs: row.lastMs ? nowMs - row.lastMs : Infinity }))
      .sort((a, b) => {
        const aFresh = a.lastMs && nowMs - a.lastMs <= 15 * 60 * 1000 ? 1 : 0;
        const bFresh = b.lastMs && nowMs - b.lastMs <= 15 * 60 * 1000 ? 1 : 0;
        if (aFresh !== bFresh) return bFresh - aFresh;
        return (b.count * 2) - (a.count * 2) || (b.lastMs || 0) - (a.lastMs || 0);
      });

    const announcementList = [...announcementLatest.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cli]) => cli);
    const failedList = failedRanked.slice(0, 300).map((x) => x.cli);
    // Priority order: newest announcement apps, then hottest failed-message CLIs,
    // then the panel's own live feed. Duplicates removed before the list is used.
    const hotList = cleanOrderedCliList([...announcementList, ...failedList, ...results.liveFeed]).slice(0, 250);
    const freshList = cleanOrderedCliList([
      ...announcementList.slice(0, 50),
      ...failedRanked.filter((x) => x.lastMs && nowMs - x.lastMs <= 15 * 60 * 1000).slice(0, 100).map((x) => x.cli),
    ]).slice(0, 120);

    results.all = cleanCliList([...results.liveFeed, ...results.announcements, ...results.failed]);
    results.hot = hotList;
    results.fresh = freshList;
    results.meta.hot = hotList.length;
    results.meta.fresh = freshList.length;
    return results;
  }

  async reloginAndRetry() {
    try {
      await this.login();
    } catch {}
  }
}
