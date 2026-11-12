import { cleanCliList } from "./clis.js";

/**
 * SignalPulse telemetry source (public, no login required).
 * Base: http://201.18.218.200:8080
 *
 * Endpoints (unauthenticated, plain JSON — no browser needed):
 *   GET /api/route1/status                 -> { total_clis, top_clis:[{cli,count}] } (hard-capped 300)
 *   GET /api/route1/messages?limit=20000   -> [{ cli, received_time, ... }]           (~1.1k CLIs)
 *   GET /api/route3/clis?limit=50000       -> { clis:[{name,count}] }                  (~7.7k CLIs)
 *   GET /api/route3/messages?limit=20000   -> { messages:[{cli, received_time}] }      (~1.1k CLIs)
 *   GET /api/simple_feed?window_minutes=0&platform=all&limit=50000
 *                                          -> { items:[{cli, timestamp, is_last_5m}] } (~8.2k rows)
 *
 * Harvest strategy:
 *   - `all`  = union of every endpoint (alpha + numeric), deduped/normalised.
 *   - `hot`  = CLIs seen in fresh telemetry, ranked by recency + frequency.
 *              Used to spend scarce Lamix searches on senders that are live now.
 *   - `fresh` = subset of `hot` seen within the last 5 minutes (highest priority).
 */
export class SignalPulseClient {
  constructor({ baseUrl = "http://201.18.218.200:8080", logger = console } = {}) {
    this.baseUrl = String(baseUrl || "http://201.18.218.200:8080").replace(/\/+$/, "");
    this.logger = logger;
  }

  async fetchJson(path, timeoutMs = 30000) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse "2026-11-12 17:07:39" (UTC) or unix seconds into ms. */
  static toMs(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") {
      return value > 1e12 ? value : Math.round(value * 1000);
    }
    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
      const n = Number(text);
      return n > 1e12 ? n : Math.round(n * 1000);
    }
    const ms = Date.parse(text.replace(" ", "T") + "Z");
    return Number.isFinite(ms) ? ms : null;
  }

  async harvest() {
    const nowMs = Date.now();

    // All calls in parallel — this source is HTTP-only and fast.
    const settled = await Promise.allSettled([
      this.fetchJson("/api/route3/clis?limit=50000", 40000),
      this.fetchJson("/api/simple_feed?window_minutes=0&platform=all&limit=50000", 40000),
      this.fetchJson("/api/route1/messages?limit=20000", 40000),
      this.fetchJson("/api/route3/messages?limit=20000", 40000),
      this.fetchJson("/api/route1/status", 15000),
    ]);
    const [r3clis, feed, r1msgs, r3msgs, r1status] = settled;

    const clis = [];
    const meta = {};
    // lower -> { cli, score, lastMs, count }
    const hot = new Map();

    const bump = (raw, score, lastMs) => {
      const cli = String(raw ?? "").trim();
      if (!cli) return;
      const key = cli.toLowerCase();
      const cur = hot.get(key);
      if (!cur) {
        hot.set(key, { cli, score, lastMs: lastMs ?? null, count: 1 });
      } else {
        cur.score += score;
        cur.count += 1;
        if (lastMs && (!cur.lastMs || lastMs > cur.lastMs)) cur.lastMs = lastMs;
      }
    };

    // 1) Route 3 full CLI dictionary (~7.7k alpha CLIs)
    if (r3clis.status === "fulfilled") {
      const j = r3clis.value;
      const list = Array.isArray(j?.clis) ? j.clis.map((x) => x?.name ?? x?.cli) : [];
      clis.push(...list);
      meta.route3Clis = { count: list.length, total: j?.total ?? null };
      // Volume ranking: high-traffic senders are worth prioritising.
      for (const row of j?.clis ?? []) {
        const n = Number(row?.count ?? 0);
        if (n > 0) bump(row?.name ?? row?.cli, Math.min(60, Math.log10(n + 1) * 15), null);
      }
      this.logger.info(`[signal] route3 clis: ${list.length} (db ${j?.total ?? "?"})`);
    } else {
      meta.route3Clis = { error: r3clis.reason?.message ?? "failed" };
      this.logger.warn(`[signal] route3 clis failed: ${r3clis.reason?.message}`);
    }

    // 2) Simple feed, all-time window (~8.2k rows, alpha + numeric)
    if (feed.status === "fulfilled") {
      const j = feed.value;
      const items = Array.isArray(j?.items) ? j.items : [];
      for (const it of items) {
        clis.push(it?.cli);
        const ts = SignalPulseClient.toMs(it?.timestamp ?? it?.received_time);
        const fresh = it?.is_last_5m === true || (ts !== null && nowMs - ts <= 5 * 60 * 1000);
        const recent = ts !== null && nowMs - ts <= 60 * 60 * 1000;
        bump(it?.cli, fresh ? 40 : recent ? 12 : 3, ts);
      }
      meta.feed = { rows: items.length, new5m: j?.new_in_last_5min ?? null };
      this.logger.info(`[signal] simple feed: ${items.length} rows`);
    } else {
      meta.feed = { error: feed.reason?.message ?? "failed" };
      this.logger.warn(`[signal] simple feed failed: ${feed.reason?.message}`);
    }

    // 3) Route 1 messages (includes numeric senders like 447873077777)
    if (r1msgs.status === "fulfilled") {
      const rows = Array.isArray(r1msgs.value) ? r1msgs.value : [];
      for (const row of rows) {
        clis.push(row?.cli);
        const ts = SignalPulseClient.toMs(row?.received_time ?? row?.timestamp);
        const recent = ts !== null && nowMs - ts <= 60 * 60 * 1000;
        bump(row?.cli, recent ? 10 : 2, ts);
      }
      meta.route1Messages = { rows: rows.length };
      this.logger.info(`[signal] route1 messages: ${rows.length} rows`);
    } else {
      meta.route1Messages = { error: r1msgs.reason?.message ?? "failed" };
      this.logger.warn(`[signal] route1 messages failed: ${r1msgs.reason?.message}`);
    }

    // 4) Route 3 messages (fresh sender activity)
    if (r3msgs.status === "fulfilled") {
      const rows = Array.isArray(r3msgs.value?.messages)
        ? r3msgs.value.messages
        : Array.isArray(r3msgs.value)
          ? r3msgs.value
          : [];
      for (const row of rows) {
        clis.push(row?.cli ?? row?.service_name);
        const ts = SignalPulseClient.toMs(row?.received_time ?? row?.timestamp);
        const recent = ts !== null && nowMs - ts <= 60 * 60 * 1000;
        bump(row?.cli ?? row?.service_name, recent ? 10 : 2, ts);
      }
      meta.route3Messages = { rows: rows.length };
      this.logger.info(`[signal] route3 messages: ${rows.length} rows`);
    } else {
      meta.route3Messages = { error: r3msgs.reason?.message ?? "failed" };
      this.logger.warn(`[signal] route3 messages failed: ${r3msgs.reason?.message}`);
    }

    // 5) Route 1 status (hard-capped top 300 + DB totals)
    if (r1status.status === "fulfilled") {
      const j = r1status.value;
      const top = Array.isArray(j?.top_clis) ? j.top_clis : [];
      clis.push(...top.map((x) => x?.cli));
      for (const row of top) bump(row?.cli, Math.min(50, Math.log10(Number(row?.count ?? 0) + 1) * 12), null);
      meta.route1Status = { totalClis: j?.total_clis ?? null, totalMessages: j?.total_messages ?? null, top: top.length };
      this.logger.info(`[signal] route1 status: top ${top.length} (db ${j?.total_clis ?? "?"})`);
    } else {
      meta.route1Status = { error: r1status.reason?.message ?? "failed" };
      this.logger.warn(`[signal] route1 status failed: ${r1status.reason?.message}`);
    }

    // Keep only hot entries that survived normalisation.
    const allClean = cleanCliList(clis);
    const keep = new Set(allClean.map((c) => c.toLowerCase()));

    const hotRanked = [...hot.values()]
      .filter((h) => keep.has(h.cli.trim().toLowerCase()))
      .sort((a, b) => {
        // Recency first (anything seen in the last 5 min wins), then volume/score.
        const aFresh = a.lastMs !== null && nowMs - a.lastMs <= 5 * 60 * 1000 ? 1 : 0;
        const bFresh = b.lastMs !== null && nowMs - b.lastMs <= 5 * 60 * 1000 ? 1 : 0;
        if (aFresh !== bFresh) return bFresh - aFresh;
        return b.score - a.score;
      });

    // "fresh" = seen in the last 5 minutes — searched more often than the rest.
    const freshList = hotRanked
      .filter((h) => h.lastMs !== null && nowMs - h.lastMs <= 5 * 60 * 1000)
      .slice(0, 200)
      .map((h) => h.cli.trim());

    const hotList = hotRanked.slice(0, 600).map((h) => h.cli.trim());

    meta.all = allClean.length;
    meta.hot = hotList.length;
    meta.fresh = freshList.length;
    meta.numeric = allClean.filter((c) => /^\d+$/.test(c)).length;

    this.logger.info(
      `[signal] harvest: ${allClean.length} unique CLIs (${meta.numeric} numeric), ` +
        `${hotList.length} hot / ${freshList.length} fresh ranked`,
    );

    return { all: allClean, hot: hotList, fresh: freshList, meta };
  }
}
