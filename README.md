# Lamix CLI Bot

Watches **CLI Search** on `panel.lamix.org` for one or more sender IDs (CLIs, e.g. `Lark`) and
sends a **Telegram alert** whenever a range shows activity inside the last **N minutes**
(default: 2). It is built to be accurate and non-spammy:

- One Telegram message per poll, grouped by CLI.
- Alerts only for `lastSeen` inside the configured window (0 – 2 minutes by default).
- Exact dedupe on `(CLI, range, lastSeen)` so the same hit is never sent twice, even after a restart.
- Per-range cooldown (default 10 minutes) so a busy range does not spam every poll.
- Uses the panel's own UI requests (the panel signs them itself). The bot does not copy,
  reverse engineer or bypass the panel's request signature.

---

## How it works

1. Logs into the panel with your account in a headless Chromium browser.
2. For each CLI, opens **CLI SEARCH**, types the CLI and presses **Search**.
3. Reads the JSON response the panel itself receives (`/api/cli-search?cli=...`).
4. Keeps ranges whose `lastSeen` is within `WINDOW_MINUTES`.
5. Sends one formatted Telegram message and records what was sent in `state.json`.

The panel returns data for the **last 24 hours**; the bot filters it down to the recent window.

---

## 1. Telegram setup

1. Open Telegram, talk to **@BotFather**, send `/newbot`, follow the steps.
2. Copy the **bot token** (`123456789:AA...`). This is `TELEGRAM_BOT_TOKEN`.
3. Create your group, add the bot to it (admin is fine, member also works).
4. Send any message in the group, then find the group id:

   ```powershell
   $env:TELEGRAM_BOT_TOKEN="123456789:AA..."
   node scripts/telegram-chat-id.js
   ```

   Group ids look like `-1001234567890`. Copy that as `TELEGRAM_CHAT_ID`.

> If the bot cannot read group messages, temporarily disable privacy mode in BotFather
> (`/setprivacy` → your bot → Disable) or just send a `/start@YourBot` command in the group
> and run the script again.

---

## 2. Run locally (Windows)

```powershell
cd "C:\Users\DEVIL_LUFFY\Documents\Default Project\LAMIX CLI HUNTING"
npm install
npx playwright install chromium

Copy-Item .env.example .env
notepad .env      # fill LAMIX_PASSWORD, LAMIX_CLIS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# one poll only, print to console, do not send Telegram:
$env:DRY_RUN="true"
npm run once

# real run (Ctrl+C to stop):
$env:DRY_RUN="false"
npm start
```

`DRY_RUN=true` prints the exact Telegram message in the console instead of sending it – use
this for the first test.

To watch several CLIs:

```env
LAMIX_CLIS=Lark,Telegram,WhatsApp
```

---

## 3. Deploy on Render

This repo includes `render.yaml` and a `Dockerfile` based on the official Playwright image,
so Chromium and its system libraries are already installed.

1. Push this folder to a GitHub repository (keep `.env` out of git – it is in `.gitignore`).
2. In Render: **New → Blueprint**, connect the repo. Render reads `render.yaml`.
3. Fill the secret env vars when prompted:
   - `LAMIX_USERNAME` – `Devil_RyomenSuk`
   - `LAMIX_PASSWORD` – your panel password
   - `LAMIX_CLIS` – e.g. `Lark`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Deploy. It runs as a **Background Worker** (always on, no HTTP port needed).

`render.yaml` also mounts a 1 GB disk at `/data` and sets `STATE_FILE=/data/state.json`, so
dedupe state survives restarts. Disks require a paid instance type; on a free setup remove the
`disk` block and the bot still works, but it may resend a hit once after a redeploy.

### Alternative: Render Web Service (free tier)

Free web services sleep after inactivity, which stops a monitor. If you still want one:

- Change `type: worker` to `type: web` and `plan: starter` to `plan: free` in `render.yaml`.
- Set `PORT=10000` (Render sets `PORT` automatically for web services). The bot starts a small
  health endpoint at `/healthz` when `PORT` is set.
- Keep an external uptime pinger hitting `/healthz` every 5 minutes, otherwise Render will sleep.

A paid Background Worker is the recommended setup for 24/7 monitoring.

---

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LAMIX_BASE_URL` | `https://panel.lamix.org` | Panel base URL |
| `LAMIX_USERNAME` | – | Panel username |
| `LAMIX_PASSWORD` | – | Panel password |
| `LAMIX_CLIS` | – | Comma separated CLIs, e.g. `Lark,Telegram` |
| `TELEGRAM_BOT_TOKEN` | – | BotFather token |
| `TELEGRAM_CHAT_ID` | – | Group/channel id (e.g. `-100...`) |
| `POLL_SECONDS` | `30` | Seconds between checks (minimum 10) |
| `WINDOW_MINUTES` | `2` | Alert if `lastSeen` is within this many minutes |
| `RANGE_COOLDOWN_MINUTES` | `10` | Mute the same CLI+range for this long after an alert |
| `FUTURE_SKEW_SECONDS` | `30` | Tolerate small clock differences on the panel |
| `STATE_FILE` | `./data/state.json` | Dedupe file (use `/data/state.json` on Render) |
| `HEADLESS` | `true` | Set `false` to watch the browser locally while debugging |
| `DRY_RUN` | `false` | Print messages instead of sending them |

### Tuning the "no spam" behaviour

- **One alert per range per 2-minute burst** – keep `RANGE_COOLDOWN_MINUTES=10`.
- **Alert again as soon as new traffic starts** – set `RANGE_COOLDOWN_MINUTES=0`. Exact
  duplicates are still blocked, but a busy range can alert every poll.
- **Stricter accuracy** – set `POLL_SECONDS=15` and `WINDOW_MINUTES=2`.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Login failed ...` | Check `LAMIX_USERNAME`/`LAMIX_PASSWORD`. The panel may require a browser login (2FA) that this bot cannot complete. |
| Panel stays on the login page | The account may be locked, or the panel is blocking the datacenter IP. Try `HEADLESS=false` locally to see the page. |
| `CLI search rejected (401)` | The session expired; the bot re-logs in automatically on the next cycle. If it repeats, the panel changed its anti-automation checks. |
| No Telegram message | Run with `DRY_RUN=true` to confirm the rule fires, then check the token/chat id. The bot logs `Telegram bot: @name` at startup. |
| Duplicate alerts after redeploy | Attach the Render disk and keep `STATE_FILE=/data/state.json`. |
| Bot works locally but not on Render | Datacenter IPs are more likely to be flagged. Try another region, or run it on your own PC/VPS. |

---

## 6. Important notice

While inspecting the panel I found a `build-integrity` / `rights` notice on the page stating that
scraping and automated emulation of the panel are prohibited and may breach its terms. This bot
automates **your own account** through the normal UI, but you should confirm you are allowed to
run automated monitoring against `panel.lamix.org` (or ask the panel admin to enable the official
REST API for your account, which currently returns `403` for this client role). Use it only on
accounts you own or are authorized to monitor.
