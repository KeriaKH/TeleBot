const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { BOT_TOKEN, GEMINI_API_KEY, MOTHER_ID } = require('./config');
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

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const menuData = loadMenuData();
const menuPriceMap = buildMenuPriceMap(menuData);

const userCarts = {};
const chatSessions = {};
const lastActiveButtons = {};

const ORDER_ACTIONS = Markup.inlineKeyboard([
    Markup.button.callback('✅ Xác Nhận Đặt Hàng', 'CONFIRM_ORDER'),
    Markup.button.callback('❌ Hủy', 'CANCEL_ORDER')
]);

function buildOrderDoneActions(orderCode) {
    return Markup.inlineKeyboard([
        Markup.button.callback('✅ Đã làm xong', `ORDER_DONE:${orderCode}`)
    ]);
}

const SYSTEM_PROMPT = `Bạn là nhân viên nhận order quán trà sữa. Bạn có khả năng ghi nhớ toàn bộ cuộc trò chuyện.
Đây là menu: ${JSON.stringify(menuData)}

Nhiệm vụ: Trò chuyện, tư vấn cho khách và LIÊN TỤC DUY TRÌ giỏ hàng của họ.

Cấu trúc JSON BẮT BUỘC:
{
    "items": [ { "name": "...", "size": "M/L", "quantity": 1, "note": "...", "price": 30000 } ],
    "total": 30000,
    "reply_message": "Câu tư vấn hoặc xác nhận của bạn."
}

--- QUY TẮC NGHIỆP VỤ ---

1. ĐỊNH DẠNG & TÍNH TIỀN:
- 'price' và 'total' phải là SỐ NGUYÊN.
- Trong 'reply_message' luôn dùng dấu chấm phân cách hàng nghìn và chữ 'đ' (VD: 30.000đ).
- Luôn hiển thị rõ size, giá tiền từng món và tổng tiền trong 'reply_message' khi xác nhận.

2. QUẢN LÝ GIỎ HÀNG:
- Nếu khách chỉ hỏi thăm, tư vấn: TUYỆT ĐỐI GIỮ NGUYÊN mảng 'items' cũ, không được làm rỗng.
- Nếu khách không chọn size thì mặc định là size M.
- Thuộc tính 'note' CHỈ dùng cho tùy chỉnh phục vụ (ít đá, ít đường,...). Tuyệt đối không dùng note để thêm topping trong menu vì nó được tính là một món riêng.

3. XỬ LÝ MÓN LẠ/SAI TÊN (QUAN TRỌNG):
- CHỈ thêm món vào giỏ khi tên món khớp rõ ràng với menu. KHÔNG tự suy đoán món gần đúng.
- Nếu khách gọi món lạ (VD: Trà xoài chanh dây), hoặc gọi sai tên (VD: Trà chanh giã tay): TUYỆT ĐỐI KHÔNG dùng 'note' để chế món. Hãy GIỮ NGUYÊN giỏ hàng hiện tại (không xóa, không đổi món cũ).
- Trong trường hợp này, 'reply_message' phải báo rõ không có món đó. Và không được gợi ý món khác nếu khách không hỏi.

--- VÍ DỤ BẮT BUỘC (FEW-SHOT) ---

User: "thêm 1 ly trà chanh giã tay"
{
  "items": [...giữ nguyên các món đã gọi trước đó...],
  "total": ...,
  "reply_message": "Dạ quán em không có Trà Chanh Giã Tay ạ."
}

User: "cho mình trà xoài chanh dây"
{
  "items": [...giữ nguyên các món đã gọi trước đó...],
  "total": ...,
  "reply_message": "Dạ menu quán em chỉ có Trà Xoài thôi, không có mix vị chanh dây ạ."
}
`;

const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
    },
    systemInstruction: SYSTEM_PROMPT
});

function extractJsonString(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        throw new Error('Gemini trả về nội dung rỗng');
    }

    if (text.startsWith('{') && text.endsWith('}')) {
        return text;
    }

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return text.slice(firstBrace, lastBrace + 1).trim();
    }

    return text;
}

async function generateOrderWithGemini(history) {
    const contents = history
        .filter((msg) => msg.role !== 'system')
        .map((msg) => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

    const result = await model.generateContent({ contents });
    return result.response.text();
}

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

function isOwnerUser(userId) {
    return String(userId) === String(MOTHER_ID);
}

function createBot() {
    const bot = new Telegraf(BOT_TOKEN);

    initMongo().catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

    bot.start((ctx) => {
        if (isOwnerUser(ctx.from.id)) {
            return ctx.reply('✅ Tài khoản chủ quán: chỉ nhận thông báo đơn hàng từ khách.');
        }

        const userName = ctx.from.first_name || 'bạn';
        ctx.reply(`Chào ${userName} 👋!Quán trà sữa xin nghe.\n\nBạn cứ gõ món muốn đặt nhé, hoặc gõ /menu để xem thực đơn hôm nay ạ!`);
    });

    bot.command('menu', (ctx) => {
        if (isOwnerUser(ctx.from.id)) {
            return ctx.reply('✅ Tài khoản chủ quán không dùng flow đặt món. Bot sẽ tự gửi đơn mới vào đây.');
        }

        ctx.reply(getFormattedMenu(menuData), { parse_mode: 'Markdown' });
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const userMessage = ctx.message.text;

        if (isOwnerUser(userId)) {
            return;
        }

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

            const responseText = await generateOrderWithGemini(chatSessions[userId]);
            const orderData = JSON.parse(extractJsonString(responseText));

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
            let orderCode = '';
            let dbReady = false;

            try {
                const db = getDb();
                if (!db) throw new Error('MongoDB chưa sẵn sàng');

                orderCode = `${Date.now()}_${userId}`;
                await db.collection('Order').insertOne({
                    order_code: orderCode,
                    status: 'confirmed',
                    telegram_id: userId,
                    customer_name: cart.customerName,
                    username: cart.username,
                    items: cart.items,
                    total_price: cart.total,
                    created_at: new Date(),
                    completed_at: null
                });
                dbReady = true;
                console.log('✅ Đã lưu đơn hàng vào MongoDB!');
            } catch (dbError) {
                console.error('Lỗi lưu MongoDB:', dbError);
            }

            const motherNotice = dbReady
                ? `${motherMsg}\n\n🧑‍🍳 Khi làm xong đơn, bấm nút bên dưới để báo khách qua lấy.`
                : `${motherMsg}\n\n⚠️ Không bật được nút báo hoàn thành vì MongoDB chưa sẵn sàng.`;

            await bot.telegram.sendMessage(
                MOTHER_ID,
                motherNotice,
                dbReady ? buildOrderDoneActions(orderCode) : undefined
            );

            const originalText = ctx.callbackQuery.message.text;
            await ctx.editMessageText(
                `${originalText}\n\n✅ ĐƠN HÀNG ĐÃ ĐƯỢC XÁC NHẬN VÀ GỬI TỚI QUÁN!`
            );

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

    bot.action(/^ORDER_DONE:(.+)$/, async (ctx) => {
        if (!isOwnerUser(ctx.from.id)) {
            return ctx.answerCbQuery('Bạn không có quyền thao tác nút này!', { show_alert: true });
        }

        const orderCode = String(ctx.match?.[1] || '').trim();
        if (!orderCode) {
            return ctx.answerCbQuery('Không tìm thấy mã đơn để xử lý.', { show_alert: true });
        }

        try {
            const db = getDb();
            if (!db) {
                return ctx.answerCbQuery('MongoDB chưa sẵn sàng, không thể hoàn tất đơn.', { show_alert: true });
            }

            const result = await db.collection('Order').findOneAndUpdate(
                { order_code: orderCode, status: { $ne: 'done' } },
                {
                    $set: {
                        status: 'done',
                        completed_at: new Date(),
                        completed_by: String(ctx.from.id)
                    }
                },
                { returnDocument: 'before' }
            );

            const order = result?.value || result;
            if (!order) {
                return ctx.answerCbQuery('Đơn đã được hoàn tất trước đó hoặc không tồn tại.', { show_alert: true });
            }

            let notifyFailed = false;
            try {
                await bot.telegram.sendMessage(
                    order.telegram_id,
                    '✅ Đơn của bạn đã làm xong rồi ạ! Mời bạn ghé quán để lấy đơn nhé 💚'
                );
            } catch (notifyError) {
                console.error('Lỗi báo khách qua lấy:', notifyError);
                notifyFailed = true;
            }

            const originalText = ctx.callbackQuery?.message?.text || '🚨 CÓ ĐƠN HÀNG MỚI!';
            await ctx.editMessageText(
                notifyFailed
                    ? `${originalText}\n\n✅ ĐƠN ĐÃ LÀM XONG (nhưng báo khách chưa thành công).`
                    : `${originalText}\n\n✅ ĐƠN ĐÃ LÀM XONG - ĐÃ BÁO KHÁCH QUA LẤY!`
            );
            await ctx.answerCbQuery(
                notifyFailed
                    ? 'Đã hoàn tất đơn, nhưng gửi tin cho khách thất bại.'
                    : 'Đã báo khách qua lấy đơn!'
            );
        } catch (error) {
            console.error('Lỗi hoàn tất đơn:', error);
            await ctx.answerCbQuery('Không thể cập nhật trạng thái đơn lúc này.', { show_alert: true });
        }
    });

    return bot;
}

module.exports = {
    createBot
};
