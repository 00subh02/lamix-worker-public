import { escapeHtml, sendTelegram } from "./telegram.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Very small Telegram command intake for /myid. Polling happens independently
 * from alert sending and stays silent unless somebody asks for the id.
 */
export function startTelegramCommandPolling({ token, logger = console }) {
  let running = true;
  let lastUpdateId = null;
  let username = null;

  const init = async () => {
    try {
      const me = await api(token, "getMe");
      username = me.result?.username?.toLowerCase() || null;
      const latest = await api(token, "getUpdates", { offset: -1, limit: 1, timeout: 0 });
      const last = latest.result?.[0]?.update_id;
      lastUpdateId = Number.isFinite(last) ? last : 0;
      logger.info(`[telegram] /myid handler ready in groups (@${username ?? "unknown"})`);
    } catch (err) {
      logger.warn(`[telegram] command handler init failed: ${err.message}`);
    }
  };

  const poll = async () => {
    if (!running || lastUpdateId === null) return;
    try {
      const res = await api(token, "getUpdates", {
        offset: lastUpdateId + 1,
        limit: 100,
        timeout: 0,
      });
      for (const update of res.result ?? []) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id ?? lastUpdateId);
        const message = update.message;
        const text = String(message?.text ?? "").trim();
        const match = text.match(/^\/(myid|my_id|chatid|getchatid)(?:@([a-z0-9_]+))?(?=\s|$)/i);
        if (!match) continue;
        const target = match[2]?.toLowerCase();
        if (target && username && target !== username) continue;

        const chat = message.chat;
        if (!chat?.id) continue;
        const chatName = escapeHtml(chat.title || chat.username || chat.type || "chat");
        const reply = `🆔 <b>Chat ID:</b> <code>${String(chat.id)}</code>\n<b>Chat:</b> ${chatName}`;
        try {
          await sendTelegram({
            token,
            chatId: String(chat.id),
            text: reply,
            dryRun: false,
            logger,
          });
          logger.info(`[telegram] replied /myid in chat ${chat.id}`);
        } catch (err) {
          logger.warn(`[telegram] /myid reply failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[telegram] /myid poll failed: ${err.message}`);
    }
  };

  init();
  const timer = setInterval(poll, 3000);
  timer.unref?.();
  return () => {
    running = false;
    clearInterval(timer);
  };
}
