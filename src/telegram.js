export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendTelegram({ token, chatId, text, entities, dryRun = false, logger = console }) {
  if (dryRun) {
    logger.info(`[dry-run] Telegram message:\n${text}`);
    return { ok: true, dryRun: true };
  }
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  // Premium custom emoji requires the entities array. Do not combine it with
  // parse_mode — Telegram rejects messages that set both.
  if (entities && entities.length) payload.entities = entities;
  else payload.parse_mode = "HTML";
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    throw new Error(`Telegram sendMessage failed (${res.status}): ${body.description || "unknown error"}`);
  }
  return body;
}

/**
 * Discover the group chat id from recent bot updates (e.g. after adding the
 * bot to a group and sending any message there). Returns null if none found.
 */
export async function discoverChatId({ token, logger = console }) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) return null;
    const chats = new Map();
    for (const update of data.result || []) {
      const message = update.message || update.edited_message || update.channel_post || update.my_chat_member || update.chat_member;
      const chat = message?.chat;
      if (!chat) continue;
      chats.set(chat.id, { id: chat.id, type: chat.type, title: chat.title || "" });
    }
    if (chats.size === 0) return null;
    const first = Array.from(chats.values())[0];
    logger.info(`[telegram] auto-discovered chat: ${JSON.stringify(first)}`);
    return String(first.id);
  } catch (err) {
    logger.warn(`[telegram] chat discovery failed: ${err.message}`);
    return null;
  }
}

export async function verifyBot({ token, logger = console }) {
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json());
    if (me.ok) {
      logger.info(`Telegram bot: @${me.result.username} (id ${me.result.id})`);
      return me.result;
    }
    logger.warn(`Telegram token check failed: ${me.description || "unknown"}`);
    return null;
  } catch (err) {
    logger.warn(`Telegram token check failed: ${err.message}`);
    return null;
  }
}

export function splitMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}
