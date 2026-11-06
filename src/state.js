import fs from "node:fs";
import path from "node:path";

/**
 * Tiny JSON-backed state store.
 *
 * alerted[key]        -> timestamp (ms) of the last Telegram alert for the exact
 *                        (cli, range, lastSeen) tuple. Prevents repeat alerts on restart.
 * rangeLastAlert[key] -> timestamp (ms) of the last alert for (cli, range). Used as a
 *                        cooldown so a busy range does not spam every poll.
 */
export class State {
  constructor(file, logger = console) {
    this.file = file;
    this.logger = logger;
    this.data = { version: 1, alerted: {}, rangeLastAlert: {} };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.data.alerted = parsed.alerted && typeof parsed.alerted === "object" ? parsed.alerted : {};
        this.data.rangeLastAlert =
          parsed.rangeLastAlert && typeof parsed.rangeLastAlert === "object" ? parsed.rangeLastAlert : {};
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.logger.warn(`[state] could not load ${this.file}: ${err.message}`);
      }
    }
  }

  save() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger.warn(`[state] could not save ${this.file}: ${err.message}`);
    }
  }

  wasAlerted(key) {
    return Boolean(this.data.alerted[key]);
  }

  rangeCooldownActive(rangeKey, nowMs, cooldownMs) {
    if (!cooldownMs) return false;
    const last = this.data.rangeLastAlert[rangeKey];
    return Boolean(last) && nowMs - last < cooldownMs;
  }

  markAlerted(key, rangeKey, nowMs) {
    this.data.alerted[key] = nowMs;
    if (rangeKey) this.data.rangeLastAlert[rangeKey] = nowMs;
  }

  prune(nowMs, maxAgeMs = 48 * 60 * 60 * 1000) {
    let removed = 0;
    for (const [key, ts] of Object.entries(this.data.alerted)) {
      if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) {
        delete this.data.alerted[key];
        removed += 1;
      }
    }
    for (const [key, ts] of Object.entries(this.data.rangeLastAlert)) {
      if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) {
        delete this.data.rangeLastAlert[key];
        removed += 1;
      }
    }
    return removed;
  }
}
