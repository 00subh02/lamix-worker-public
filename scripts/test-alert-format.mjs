/**
 * Verifies the alert text + Telegram entities match the reference Premium
 * emoji format exactly (including UTF-16 offsets).
 *   node scripts/test-alert-format.mjs
 */
import assert from "node:assert/strict";
import { buildAlertMessage, splitAlertMessage } from "../src/alert-format.js";

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

CLI: TikTok
1. Range: Malaysia Celcom LX 02Nov
Time: 14s ago · 1:31 AM 
2. Range: Malaysia Maxis LX 02Nov
Time: 1m 01s ago · 1:30 AM

CLI: Apple
Range: Tunisia Tunisiana NEW LX 16Sep
Time: 1m 21s ago · 1:30 AM 

CLI: Bumble
Range: Haiti LX 20Nov
Time: 9s ago · 1:31 AM 

CLI: Yango
Range: Tunisia (Fresh) 22Oct
Time: 1m 48s ago · 1:29 AM`;

const expectedEntities = [
  [0, 2, "custom_emoji", "5382357040008021292"],
  [3, 15, "bold"],
  [18, 2, "custom_emoji", "5778673721317267508"],
  [20, 2, "custom_emoji", "5778673721317267508"],
  [22, 2, "custom_emoji", "5778673721317267508"],
  [73, 4, "bold"], [78, 6, "code"],
  [85, 9, "bold"], [95, 24, "code"], [120, 5, "bold"],
  [145, 9, "bold"], [155, 23, "code"], [179, 5, "bold"],
  [207, 4, "bold"], [212, 5, "code"],
  [218, 6, "bold"], [225, 30, "code"], [256, 5, "bold"],
  [285, 4, "bold"], [290, 6, "code"],
  [297, 6, "bold"], [304, 14, "code"], [319, 5, "bold"],
  [344, 4, "bold"], [349, 5, "code"],
  [355, 6, "bold"], [362, 21, "code"], [384, 5, "bold"],
];

const alert = buildAlertMessage({ cycles, nowMs: now, windowMinutes: 2 });
assert.equal(alert.text, expectedText, "alert text differs from reference");
assert.deepEqual(
  alert.entities.map((e) => [e.offset, e.length, e.type, e.custom_emoji_id].filter((v) => v !== undefined)),
  expectedEntities,
  "entity offsets/types/emoji ids differ from reference",
);

// Splitting must keep every entity attached to the right text.
const many = Array.from({ length: 40 }, (_, i) => ({
  cli: `CLI_${i}`,
  alerts: [ago(5 + i, `Range ${i}`)],
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

console.log(`PASS: exact reference text + ${alert.entities.length} entities; long alert split into ${parts.length} parts`);
