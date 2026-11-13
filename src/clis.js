import fs from "node:fs";
import path from "node:path";

/**
 * Normalise a CLI for dedupe. Lamix CLI search is case-insensitive,
 * so we dedupe on lowercase but keep the original casing for search.
 */
export function normalizeCli(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, " ").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9 ]+$/g, "").trim();
}

export function cleanCliList(list, { minLen = 2, maxLen = 30 } = {}) {
  const seen = new Map(); // lower -> original
  for (const item of list ?? []) {
    const cli = normalizeCli(item);
    if (!cli) continue;
    if (cli.length < minLen || cli.length > maxLen) continue;
    // Drop pure separator artifacts like "---" (already stripped) and bare symbols
    if (!/[A-Za-z0-9]/.test(cli)) continue;
    // Keep numeric senders too (short codes like "5844" and full numbers like
    // "447873077777") — Lamix/Matrix both expose numeric CLIs and they are
    // real, searchable senders. Nothing is dropped on numeric shape anymore.
    const key = cli.toLowerCase();
    if (!seen.has(key)) seen.set(key, cli);
  }
  return Array.from(seen.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Persistent CLI store: merges Matrix-harvested CLIs with manually configured
 * ones and writes to disk so CLIs never get lost across restarts.
 *
 * Data written to CLI_FILE (default ./data/clis.json):
 * {
 *   version: 1,
 *   updatedAt: ISO string,
 *   clis: ["Facebook", "Lark", ...],
 *   meta: { manual: [...], matrixLiveFeed: N, matrixAnnouncements: N, matrixFailed: N }
 * }
 */
export class CliStore {
  constructor({ file, logger = console }) {
    this.file = file;
    this.logger = logger;
    this.clis = [];
    this.meta = {};
    this.updatedAt = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.clis)) this.clis = cleanCliList(parsed.clis);
      this.meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
      this.updatedAt = parsed.updatedAt || null;
    } catch (err) {
      if (err.code !== "ENOENT") this.logger.warn(`[cli-store] could not load ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.file) return false;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        clis: this.clis,
        meta: this.meta,
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.file);
      this.updatedAt = payload.updatedAt;
      return true;
    } catch (err) {
      this.logger.warn(`[cli-store] could not save ${this.file}: ${err.message}`);
      return false;
    }
  }

  /**
   * Merge sources. Each source is an array of raw CLI strings.
   * Returns { added: number, total: number }.
   */
  merge(sources) {
    const before = new Set(this.clis.map((c) => c.toLowerCase()));
    const merged = cleanCliList([...this.clis, ...sources.flatMap((s) => s ?? [])]);
    const added = merged.filter((c) => !before.has(c.toLowerCase()));
    if (added.length > 0) {
      this.clis = merged;
      this.save();
    }
    return { added: added.length, total: this.clis.length };
  }

  setMeta(patch) {
    const next = { ...this.meta, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.meta)) return false;
    this.meta = next;
    return this.save();
  }

  snapshot() {
    return [...this.clis];
  }
}
