/**
 * Verifies the alert text + Telegram Premium emoji entities.
 *   node scripts/test-alert-format.mjs
 */
import assert from "node:assert/strict";
import { buildAlertMessage, splitAlertMessage, PREMIUM_EMOJI } from "../src/alert-format.js";

const now = Date.parse("2026-11-22T20:01:21Z"); // 1:31:21 AM IST
const ago = (sec, range) => ({ range, lastSeenMs: now - sec * 1000, ageMs: sec * 1000 });
const cycles = [
  { cli: "TikTok", alerts: [ago(14, "Malaysia Celcom LX 02Nov"), ago(61, "Malaysia Maxis LX 02Nov")] },
  { cli: "Apple", alerts: [ago(81, "Tunisia Tunisiana NEW LX 16Sep")] },
  { cli: "Bumble", alerts: [ago(9, "Haiti LX 20Nov")] },
  { cli: "Yango", alerts: [ago(108, "Tunisia (Fresh) 22Oct")] },
];

const expectedText = `🆕 LAMIX CLI ALERT🎤🎤🎤
23 Nov 2026 · 1:31 AM IST · 0-2 MIN · 5 RANGES

CLI: ✨ TikTok
🔢 🌐: Malaysia Celcom LX 02Nov
Time: 14s ago · 1:31 AM 
🔢 🌐: Malaysia Maxis LX 02Nov
Time: 1m 01s ago · 1:30 AM

CLI: ✨ Apple
🌐: Tunisia Tunisiana NEW LX 16Sep
Time: 1m 21s ago · 1:30 AM 

CLI: ✨ Bumble
🌐: Haiti LX 20Nov
Time: 9s ago · 1:31 AM 

CLI: ✨ Yango
🌐: Tunisia (Fresh) 22Oct
Time: 1m 48s ago · 1:29 AM`;

const n = PREMIUM_EMOJI.NUMBERS;
const expectedEntities = [
  [0, 2, "custom_emoji", PREMIUM_EMOJI.NEW],
  [3, 15, "bold"],
  [18, 2, "custom_emoji", PREMIUM_EMOJI.MIC],
  [20, 2, "custom_emoji", PREMIUM_EMOJI.MIC],
  [22, 2, "custom_emoji", PREMIUM_EMOJI.MIC],
  [73, 4, "bold"], [78, 1, "custom_emoji", PREMIUM_EMOJI.SPARKLE], [80, 6, "code"],
  [87, 2, "custom_emoji", n[0]], [90, 2, "custom_emoji", PREMIUM_EMOJI.GLOBE], [94, 24, "code"], [119, 5, "bold"],
  [144, 2, "custom_emoji", n[1]], [147, 2, "custom_emoji", PREMIUM_EMOJI.GLOBE], [151, 23, "code"], [175, 5, "bold"],
  [203, 4, "bold"], [208, 1, "custom_emoji", PREMIUM_EMOJI.SPARKLE], [210, 5, "code"],
  [216, 2, "custom_emoji", PREMIUM_EMOJI.GLOBE], [220, 30, "code"], [251, 5, "bold"],
  [280, 4, "bold"], [285, 1, "custom_emoji", PREMIUM_EMOJI.SPARKLE], [287, 6, "code"],
  [294, 2, "custom_emoji", PREMIUM_EMOJI.GLOBE], [298, 14, "code"], [313, 5, "bold"],
  [338, 4, "bold"], [343, 1, "custom_emoji", PREMIUM_EMOJI.SPARKLE], [345, 5, "code"],
  [351, 2, "custom_emoji", PREMIUM_EMOJI.GLOBE], [355, 21, "code"], [377, 5, "bold"],
];

const alert = buildAlertMessage({ cycles, nowMs: now, windowMinutes: 2 });
assert.equal(alert.text, expectedText, "alert text differs from reference");
assert.deepEqual(
  alert.entities.map((e) => [e.offset, e.length, e.type, e.custom_emoji_id].filter((v) => v !== undefined)),
  expectedEntities,
  "entity offsets/types/emoji ids differ from reference",
);
assert.ok(!alert.entities.some((e) => e.type === "custom_emoji" && !e.custom_emoji_id), "missing custom_emoji_id");

// Splitting must keep every entity attached to the right text.
const many = Array.from({ length: 40 }, (_, i) => ({
  cli: `CLI_${i}`,
  alerts: [ago(5 + i, `Range ${i}`), ago(6 + i, `Range ${i} b`)],
}));
const longAlert = buildAlertMessage({ cycles: many, nowMs: now, windowMinutes: 2 });
const parts = splitAlertMessage(longAlert, 800);
assert.ok(parts.length > 1, "expected long alert to split into multiple parts");
for (const part of parts) {
  assert.ok(part.text.length <= 800, "part exceeds limit");
  for (const e of part.entities) {
    assert.equal(part.text.slice(e.offset, e.offset + e.length).length, e.length, "entity offset out of range");
  }
}

console.log(`PASS: reference text + ${alert.entities.length} entities; long alert split into ${parts.length} parts`);
