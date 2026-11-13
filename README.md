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

## 3. Deploy on a VPS (current production path)

The repo ships a Playwright-based `Dockerfile`, so Chromium and its system libraries are already installed.

```bash
cd /opt/lamix-cli-bot/lamix-cli-bot
git pull --ff-only
docker build -t lamix-cli-bot .

# Docker does not re-read .env on `docker restart`. After editing .env, recreate the container.
docker rm -f lamix-bot
docker run -d --name lamix-bot \
  --restart always \
  --env-file .env \
  -v /opt/lamix-data:/app/data \
  -p 10000:10000 \
  lamix-cli-bot
```

Useful checks:

```bash
docker ps --filter name=lamix-bot
docker logs --tail 80 lamix-bot
curl http://127.0.0.1:10000/healthz
```

The bot needs:
- `TELEGRAM_BOT_TOKEN` and at least one chat id in `TELEGRAM_CHAT_ID` (comma-separated).
- `/opt/lamix-data:/app/data` so the CLI pool and alert dedupe state survive redeploys.
- A small health endpoint at `/healthz` when `PORT` is set.

### Legacy Render notes

`render.yaml` is still present for reference, but Render's free tier sleeps and is not suitable for 24/7 monitoring. If you use Render, keep `/data/state.json` on a persistent disk to avoid duplicate alerts.

---

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LAMIX_BASE_URL` | `https://panel.lamix.org` | Panel base URL |
| `LAMIX_USERNAME` | – | Panel username |
| `LAMIX_PASSWORD` | – | Panel password |
| `LAMIX_CLIS` | – | Comma separated high-priority CLIs, e.g. `Lark` |
| `PRIORITY_CLIS` | `Lark` | CLIs searched first every cycle |
| `TELEGRAM_BOT_TOKEN` | – | BotFather token |
| `TELEGRAM_CHAT_ID` | – | Group/channel id(s) (e.g. `-100...,-100...`) |
| `POLL_SECONDS` | `10` | Seconds between checks (minimum 10) |
| `WINDOW_MINUTES` | `5` | Alert if `lastSeen` is within this many minutes |
| `RANGE_COOLDOWN_MINUTES` | `10` | Mute the same CLI+range for this long after an alert |
| `CLIS_PER_CYCLE` | `12` | CLIs per cycle after priority+fresh/hot selection |
| `SEARCH_PACING_MS` | `4000` | Base pacing between searches; adaptive 429 control overrides it |
| `CYCLE_SECONDS` | `300` | Per-cycle safety deadline |
| `FUTURE_SKEW_SECONDS` | `30` | Tolerate small clock differences on the panel |
| `MATRIX_ENABLED` | `true` | Harvest MatrixPanel CLI pool |
| `MATRIX_REFRESH_MINUTES` | `60` | Re-harvest Matrix live feed interval |
| `SIGNAL_ENABLED` | `true` | Harvest SignalPulse CLI telemetry |
| `SIGNAL_REFRESH_MINUTES` | `5` | Re-rank SignalPulse fresh/hot CLIs |
| `STATE_FILE` | `./data/state.json` | Dedupe file (use a persistent path in production) |
| `CLI_FILE` | `./data/clis.json` | Persistent CLI pool |
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
| Duplicate alerts after redeploy | Keep `STATE_FILE=/data/state.json` on the persistent `/data` volume; `state.json` stores alert dedupe across restarts. |
| Bot works locally but not on VPS | Datacenter IPs may be more visible to the panel. Watch `/healthz`, `docker logs`, and retry from another region if the panel starts rejecting the session. |
| GitHub history still shows old credentials | Rotate every credential that was ever committed to this repository, including the Lamix, Matrix, Telegram bot token, and VPS root password. |

---

## 6. Important notice

While inspecting the panel I found a `build-integrity` / `rights` notice on the page stating that
scraping and automated emulation of the panel are prohibited and may breach its terms. This bot
automates **your own account** through the normal UI, but you should confirm you are allowed to
run automated monitoring against `panel.lamix.org` (or ask the panel admin to enable the official
REST API for your account, which currently returns `403` for this client role). Use it only on
accounts you own or are authorized to monitor.
