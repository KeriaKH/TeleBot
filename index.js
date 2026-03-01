const { createBot } = require('./src/bot');
const express = require('express');

const app = express();
const bot = createBot();

app.get('/', (req, res) => {
    res.send('🤖 Bot Trà Sữa Mẹ Làm đang hoạt động mượt mà!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web server đang chạy ở port ${PORT} để giữ bot thức!`);
});

bot.launch();
console.log('🤖 Bot Trà Sữa đã khởi động thành công!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));