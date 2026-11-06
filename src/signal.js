import { cleanCliList } from "./clis.js";

/**
 * SignalPulse telemetry source (public, no login required).
 * Base: http://201.18.218.200:8080
 * Endpoints (unauthenticated, fast):
 *   GET /api/route1/status               -> { top_clis: [{cli, count}] }  (7328 CLIs DB)
 *   GET /api/route2/clis                 -> [{cli, count}]
 *   GET /api/route3/clis                 -> { clis: [{name, count}] }
 *   GET /api/simple_feed?window_minutes=5&platform=all&limit=200
 *                                          -> { items: [{cli, ...}] }
 *
 * This is the fastest CLI source: plain HTTP JSON, no browser needed.
 */
export class SignalPulseClient {
  constructor({ baseUrl = "http://201.18.218.200:8080", logger = console } = {}) {
    this.baseUrl = String(baseUrl || "http://201.18.218.200:8080").replace(/\/+$/, "");
    this.logger = logger;
  }

  async fetchJson(path) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async harvest() {
    const clis = [];
    const meta = {};

    // Route 1 - biggest pool (7328 CLIs, 647k msgs)
    try {
      const j = await this.fetchJson("/api/route1/status");
      const top = Array.isArray(j.top_clis) ? j.top_clis.map((x) => x.cli) : [];
      clis.push(...top);
      meta.route1 = { total: j.total_clis, msgs: j.total_messages, top: top.length };
      this.logger.info(`[signal] route1: ${top.length} top CLIs (db ${j.total_clis})`);
    } catch (err) {
      this.logger.warn(`[signal] route1 failed: ${err.message}`);
    }

    // Route 3 - active agents
    try {
      const j = await this.fetchJson("/api/route3/clis");
      const list = Array.isArray(j.clis) ? j.clis.map((x) => x.name) : [];
      clis.push(...list);
      meta.route3 = { count: list.length };
      this.logger.info(`[signal] route3: ${list.length} CLIs`);
    } catch (err) {
      this.logger.warn(`[signal] route3 failed: ${err.message}`);
    }

    // Route 2 - smaller, direct
    try {
      const j = await this.fetchJson("/api/route2/clis");
      const list = Array.isArray(j) ? j.map((x) => x.cli) : [];
      clis.push(...list);
      meta.route2 = { count: list.length };
      this.logger.info(`[signal] route2: ${list.length} CLIs`);
    } catch (err) {
      this.logger.warn(`[signal] route2 failed: ${err.message}`);
    }

    // Simple feed - very fresh signals (last 5m)
    try {
      const j = await this.fetchJson("/api/simple_feed?window_minutes=5&platform=all&limit=200");
      const items = Array.isArray(j.items) ? j.items.map((x) => x.cli) : [];
      clis.push(...items);
      meta.feed = { count: items.length, new: j.new_in_last_5min };
      this.logger.info(`[signal] feed: ${items.length} fresh CLIs`);
    } catch (err) {
      this.logger.warn(`[signal] feed failed: ${err.message}`);
    }

    return { all: cleanCliList(clis), meta };
  }
}
