/**
 * Telegram alert formatter using Premium custom emoji entities.
 *
 * Telegram entities use UTF-16 offsets, which is exactly what JS string
 * indexing gives us. We build the text and entities together so the offsets
 * are always correct, then split long alerts without breaking any entity.
 */

export const PREMIUM_EMOJI = Object.freeze({
  NEW: "5382357040008021292", // 🆕
  MIC: "5778673721317267508", // 🎤
});

function formatAge(ageMs) {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${String(r).padStart(2, "0")}s ago` : `${m}m ago`;
}

function istDate(ms) {
  return new Date(ms + 5.5 * 60 * 60 * 1000);
}

function formatIstClock(ms) {
  const d = istDate(ms);
  let hours = d.getUTCHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm}`;
}

function formatIstShort(ms) {
  return `${formatIstClock(ms)} IST`;
}

function formatIstStamp(ms) {
  const d = istDate(ms);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()} · ${formatIstShort(ms)}`;
}

/**
 * Build { text, entities } matching the reference alert exactly:
 *   🆕 LAMIX CLI ALERT🎤🎤🎤
 *   23 Nov 2026 · 1:31 AM IST · 0-2 MIN · 5 RANGES
 *
 *   CLI: TikTok
 *   1. Range: Malaysia Celcom LX 02Nov
 *   Time: 14s ago · 1:31 AM
 *   ...
 */
export function buildAlertMessage({ cycles, nowMs, windowMinutes, emoji = PREMIUM_EMOJI }) {
  const total = cycles.reduce((sum, c) => sum + (c.alerts?.length ?? 0), 0);
  const rangeWord = total === 1 ? "RANGE" : "RANGES";

  // Most productive CLIs first — keeps the freshest ranges at the top.
  const sorted = [...cycles]
    .filter((c) => c.alerts?.length)
    .sort((a, b) => b.alerts.length - a.alerts.length);

  let text = "";
  const entities = [];
  const push = (s) => { text += s; };
  const add = (type, value, extra) => {
    const offset = text.length;
    push(value);
    entities.push({ offset, length: value.length, type, ...(extra ?? {}) });
  };

  // Header with Premium emoji (custom_emoji entities must carry raw emoji glyphs).
  add("custom_emoji", "🆕", { custom_emoji_id: emoji.NEW });
  push(" ");
  add("bold", "LAMIX CLI ALERT");
  add("custom_emoji", "🎤", { custom_emoji_id: emoji.MIC });
  add("custom_emoji", "🎤", { custom_emoji_id: emoji.MIC });
  add("custom_emoji", "🎤", { custom_emoji_id: emoji.MIC });
  push("\n");
  push(`${formatIstStamp(nowMs)} · 0-${windowMinutes} MIN · ${total} ${rangeWord}\n`);
  push("\n");

  for (const cycle of sorted) {
    const multi = cycle.alerts.length > 1;
    add("bold", "CLI:");
    push(" ");
    add("code", String(cycle.cli));
    push("\n");

    cycle.alerts.forEach((a, index) => {
      const num = multi ? `${index + 1}. ` : "";
      const isLast = index === cycle.alerts.length - 1;
      add("bold", `${num}Range:`);
      push(" ");
      add("code", String(a.range));
      push("\n");
      add("bold", "Time:");
      // The reference alert omits the trailing space on the final range of a
      // multi-range block; every other Time line keeps it.
      const trailing = multi && isLast ? "" : " ";
      push(` ${formatAge(a.ageMs)} · ${formatIstClock(a.lastSeenMs)}${trailing}\n`);
    });
    push("\n");
  }

  // No trailing blank lines in the reference message.
  text = text.replace(/\s+$/, "");
  return { text, entities };
}

/**
 * Split a message at line boundaries while keeping every entity inside the
 * part that contains it, with offsets rebased to the part.
 */
export function splitAlertMessage({ text, entities = [] }, limit = 4000) {
  if (text.length <= limit) return [{ text, entities }];

  const lines = text.split("\n");
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }

  const chunks = [];
  let current = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = current ? `${current}\n${lines[i]}` : lines[i];
    if (candidate.length > limit && current) {
      chunks.push({ text: current, startLine, endLine: i - 1 });
      current = lines[i];
      startLine = i;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push({ text: current, startLine, endLine: lines.length - 1 });

  return chunks.map((chunk) => {
    const base = lineStarts[chunk.startLine];
    const partEnd = base + chunk.text.length;
    const partEntities = entities
      .filter((e) => e.offset >= base && e.offset + e.length <= partEnd)
      .map((e) => ({ ...e, offset: e.offset - base }));
    return { text: chunk.text, entities: partEntities };
  });
}
