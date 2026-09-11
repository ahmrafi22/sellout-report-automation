import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN, registerRecipient, unregisterRecipient } from './telegram.js';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Only 3 commands in menu — keeps it simple
bot.setMyCommands([
  { command: 'start', description: 'Show welcome message' },
  { command: 'register', description: 'Register to receive updates' },
  { command: 'unregister', description: 'Stop receiving updates' },
]).catch((e) => console.error('setMyCommands failed:', e.message));

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  if (text === '/start') {
    await bot.sendMessage(chatId,
      'Welcome — simple bot.\n' +
      '/register — save your chat id + username to keys.json\n' +
      '/unregister — remove your chat id\n' +
      'Just send any text and the bot will reply.'
    );
    return;
  }

  if (text === '/register') {
    const username = msg.from?.username ? '@' + msg.from.username : null;
    try {
      const saved = registerRecipient(chatId, username);
      await bot.sendMessage(chatId,
        saved
          ? `Registered. Chat id: ${chatId}${username ? ' (' + username + ')' : ''}`
          : `Already registered. Chat id: ${chatId}`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `Register failed: ${e.message}`);
    }
    return;
  }

  if (text === '/unregister') {
    try {
      const removed = unregisterRecipient(chatId);
      await bot.sendMessage(chatId,
        removed
          ? `Unregistered. Chat id: ${chatId}`
          : `You are not registered. Chat id: ${chatId}`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `Unregister failed: ${e.message}`);
    }
    return;
  }

  // Unknown slash command
  if (text.startsWith('/')) {
    await bot.sendMessage(chatId, 'Unknown command. Use /start, /register, /unregister');
    return;
  }

  // Users can send any message to the bot — echo back, log locally
  console.log(`[telegram] message from ${chatId} (@${msg.from?.username || 'no-username'}): ${text}`);
  try {
    await bot.sendMessage(chatId, `Message received: ${text}`);
  } catch (e) {
    console.error('send failed:', e.message);
  }
});

console.log('Telegram bot (setup_telegram) started. Commands: /start /register /unregister — polling');
