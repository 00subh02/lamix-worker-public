// Prints recent chats that have messaged your Telegram bot.
// Usage:
//   TELEGRAM_BOT_TOKEN=123:abc node scripts/telegram-chat-id.js
//   node scripts/telegram-chat-id.js 123:abc
//
// Steps: create the bot, add it to the group, then send a message in the group
// (or any command like /start@YourBot). Run this script and copy the id.

const token = process.env.TELEGRAM_BOT_TOKEN || process.argv[2];

if (!token) {
  console.error("Usage: TELEGRAM_BOT_TOKEN=123:abc node scripts/telegram-chat-id.js");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json().catch(() => ({}));

if (!data.ok) {
  console.error(`Telegram error: ${data.description || res.status}`);
  process.exit(1);
}

const chats = new Map();
for (const update of data.result || []) {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.my_chat_member ||
    update.chat_member;
  const chat = message?.chat;
  if (!chat) continue;
  chats.set(chat.id, {
    id: chat.id,
    type: chat.type,
    title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" "),
    username: chat.username,
  });
}

if (chats.size === 0) {
  console.log("No chats found yet.");
  console.log("Add the bot to your group, send any message there, then run this again.");
} else {
  console.log("Chats found (use the id as TELEGRAM_CHAT_ID):");
  for (const chat of chats.values()) console.log(chat);
}
