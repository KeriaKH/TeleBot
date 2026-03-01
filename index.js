const { createBot } = require('./src/bot');

const bot = createBot();

bot.launch();
console.log('🤖 Bot Trà Sữa đã khởi động thành công!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));