const { Telegraf, Markup } = require('telegraf');
const Groq = require('groq-sdk');

const { BOT_TOKEN, GROQ_API_KEY, MOTHER_ID } = require('./config');
const { initMongo, getDb } = require('./db');
const {
    loadMenuData,
    buildMenuPriceMap,
    getFormattedMenu,
    isMenuIntent
} = require('./services/menuService');
const {
    sanitizeAndRecalculateItems,
    trimChatHistory,
    buildAssistantStateMessage,
    isSameOrder
} = require('./services/orderService');
const {
    buildSafeOrderReply,
    buildMotherOrderMessage
} = require('./services/messageService');

const groq = new Groq({ apiKey: GROQ_API_KEY });

const menuData = loadMenuData();
const menuPriceMap = buildMenuPriceMap(menuData);

const userCarts = {};
const chatSessions = {};
const lastActiveButtons = {};

const ORDER_ACTIONS = Markup.inlineKeyboard([
    Markup.button.callback('✅ Xác Nhận Đặt Hàng', 'CONFIRM_ORDER'),
    Markup.button.callback('❌ Hủy', 'CANCEL_ORDER')
]);

const SYSTEM_PROMPT = `Bạn là nhân viên nhận order quán trà sữa. Bạn có khả năng ghi nhớ toàn bộ cuộc trò chuyện.
Đây là menu: ${JSON.stringify(menuData)}

Nhiệm vụ: Trò chuyện, tư vấn cho khách và LIÊN TỤC DUY TRÌ giỏ hàng của họ.

Cấu trúc JSON BẮT BUỘC:
{
    "items": [ { "name": "...", "size": "M/L", "quantity": 1, "note": "...", "price": 30000 } ],
    "total": 30000,
    "reply_message": "Câu tư vấn hoặc xác nhận của bạn."
}

QUY TẮC SỐNG CÒN:
1. Nếu khách gọi thêm/xóa món, hãy cập nhật lại mảng 'items'.
2. Nếu khách chỉ hỏi thăm, TUYỆT ĐỐI GIỮ NGUYÊN mảng 'items' cũ, không được làm rỗng.
3. 'price' và 'total' là SỐ NGUYÊN.
4. Trong 'reply_message' luôn dùng dấu chấm phân cách hàng nghìn và chữ 'đ' (VD: 30.000đ).
5. Nếu khách không chọn size thì mặc định là size M.
6. Khi trả lời xác nhận luôn hiển thị size và giá tiền từng món, cũng như tổng tiền cuối cùng.
7. Ghi chú ('note') CHỈ dùng cho tùy chỉnh phục vụ như: ít đá, ít đường, thêm topping, mang đi. Không dùng note để tạo hương vị/món mới.
8. Nếu khách gọi món hoặc biến thể KHÔNG có trong menu (ví dụ: "Trà Xoài chanh dây"), KHÔNG được tách "chanh dây" vào note. Hãy giữ nguyên giỏ hiện tại và reply_message phải báo rõ món này không có trong menu.`;

async function safeDeleteMessage(ctx, messageId) {
    if (!messageId) return;
    try {
        await ctx.deleteMessage(messageId);
    } catch (e) {}
}

async function safeClearInlineKeyboard(ctx, messageId) {
    if (!messageId) return;
    try {
        await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, messageId, undefined, { inline_keyboard: [] });
    } catch (e) {}
}

function createBot() {
    const bot = new Telegraf(BOT_TOKEN);

    initMongo().catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

    bot.start((ctx) => {
        const userName = ctx.from.first_name || 'bạn';
        ctx.reply(`Chào ${userName} 👋!Quán trà sữa xin nghe.\n\nBạn cứ gõ món muốn đặt nhé, hoặc gõ /menu để xem thực đơn hôm nay ạ!`);
    });

    bot.command('menu', (ctx) => {
        ctx.reply(getFormattedMenu(menuData), { parse_mode: 'Markdown' });
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const userMessage = ctx.message.text;

        if (userMessage.startsWith('/')) return;

        if (isMenuIntent(userMessage)) {
            await ctx.reply(getFormattedMenu(menuData), { parse_mode: 'Markdown' });
            return;
        }

        const thinkingMsg = await ctx.reply('⏳ Đợi mình xíu nhé...');

        try {
            if (!chatSessions[userId]) {
                chatSessions[userId] = [{ role: 'system', content: SYSTEM_PROMPT }];
            }

            chatSessions[userId].push({ role: 'user', content: userMessage });
            trimChatHistory(chatSessions[userId]);

            const completion = await groq.chat.completions.create({
                messages: chatSessions[userId],
                model: 'llama-3.3-70b-versatile',
                response_format: { type: 'json_object' },
                temperature: 0.2
            });

            const responseText = completion.choices[0].message.content;
            const orderData = JSON.parse(responseText.trim());

            await safeDeleteMessage(ctx, thinkingMsg.message_id);

            if (orderData.items && orderData.items.length > 0) {
                const recalculatedOrder = sanitizeAndRecalculateItems(orderData.items, menuPriceMap);

                const safeReplyMessage = buildSafeOrderReply(recalculatedOrder.items, recalculatedOrder.total);
                const previousCart = userCarts[userId];
                const orderChanged = !isSameOrder(previousCart, recalculatedOrder);
                const needReceiptRender = orderChanged || !lastActiveButtons[userId];

                userCarts[userId] = {
                    customerName: ctx.from.first_name || 'Khách',
                    username: ctx.from.username || 'Không có',
                    items: recalculatedOrder.items,
                    total: recalculatedOrder.total
                };

                chatSessions[userId].push({
                    role: 'assistant',
                    content: buildAssistantStateMessage(recalculatedOrder.items, recalculatedOrder.total)
                });
                trimChatHistory(chatSessions[userId]);

                if (needReceiptRender) {
                    await safeClearInlineKeyboard(ctx, lastActiveButtons[userId]);

                    const sentMsg = await ctx.reply(safeReplyMessage, ORDER_ACTIONS);
                    lastActiveButtons[userId] = sentMsg.message_id;
                    return;
                }

                const consultReply = String(orderData.reply_message || '').trim();
                await ctx.reply(consultReply || 'Mình vẫn giữ nguyên đơn hiện tại nha. Bạn muốn mình tư vấn thêm món nào không?');
            } else {
                chatSessions[userId].push({
                    role: 'assistant',
                    content: String(orderData.reply_message || '')
                });
                trimChatHistory(chatSessions[userId]);
                await ctx.reply(String(orderData.reply_message || 'Bạn muốn mình gợi ý vài món dễ uống không?'));
            }
        } catch (error) {
            console.error('Lỗi AI hoặc Logic:', error);

            await safeDeleteMessage(ctx, thinkingMsg.message_id);
            await ctx.reply('Xin lỗi bạn, quán đang quá tải tin nhắn. Bạn vui lòng nhắn lại giúp quán nhé!');
        }
    });

    bot.action('CONFIRM_ORDER', async (ctx) => {
        const userId = ctx.from.id;
        const cart = userCarts[userId];

        if (!cart) {
            return ctx.answerCbQuery('Giỏ hàng đã hết hạn. Bạn vui lòng đặt lại nhé!', { show_alert: true });
        }

        const motherMsg = buildMotherOrderMessage(cart);

        try {
            await bot.telegram.sendMessage(MOTHER_ID, motherMsg);

            const originalText = ctx.callbackQuery.message.text;
            await ctx.editMessageText(
                `${originalText}\n\n✅ ĐƠN HÀNG ĐÃ ĐƯỢC XÁC NHẬN VÀ GỬI TỚI QUÁN!`
            );

            try {
                const db = getDb();
                if (!db) throw new Error('MongoDB chưa sẵn sàng');

                await db.collection('Order').insertOne({
                    telegram_id: userId,
                    customer_name: cart.customerName,
                    username: cart.username,
                    items: cart.items,
                    total_price: cart.total,
                    created_at: new Date()
                });
                console.log('✅ Đã lưu đơn hàng vào MongoDB!');
            } catch (dbError) {
                console.error('Lỗi lưu MongoDB:', dbError);
            }

            delete userCarts[userId];
            delete chatSessions[userId];
            delete lastActiveButtons[userId];
        } catch (error) {
            console.error('Lỗi gửi tin cho Mẹ:', error);
            await ctx.answerCbQuery('Lỗi hệ thống, không thể gửi đơn cho quán!', { show_alert: true });
        }
    });

    bot.action('CANCEL_ORDER', async (ctx) => {
        const userId = ctx.from.id;

        const originalText = ctx.callbackQuery.message.text;
        await ctx.editMessageText(`${originalText}\n\n❌ ĐƠN HÀNG ĐÃ BỊ HỦY!`);

        delete userCarts[userId];
        delete chatSessions[userId];
        delete lastActiveButtons[userId];
    });

    return bot;
}

module.exports = {
    createBot
};
