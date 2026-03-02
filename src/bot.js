const { Telegraf, Markup } = require('telegraf');

const { BOT_TOKEN, GEMINI_API_KEY, MOTHER_ID } = require('./config');
const { initMongo, getDb } = require('./db');
const {
    loadMenuData,
    buildMenuPriceMap,
    getFormattedMenu
} = require('./services/menuService');
const {
    buildMotherOrderMessage
} = require('./services/messageService');
const { createAiOrderService } = require('./services/aiOrderService');
const { createTextMessageHandler } = require('./handlers/textMessageHandler');
const { safeDeleteMessage, safeClearInlineKeyboard, isOwnerUser } = require('./utils/telegramHelpers');

const menuData = loadMenuData();
const menuPriceMap = buildMenuPriceMap(menuData);
const { systemPrompt, generateOrderWithGemini } = createAiOrderService({
    apiKey: GEMINI_API_KEY,
    menuData
});

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

    const handleTextMessage = createTextMessageHandler({
        menuData,
        menuPriceMap,
        userCarts,
        chatSessions,
        lastActiveButtons,
        orderActions: ORDER_ACTIONS,
        isOwnerUser,
        safeDeleteMessage,
        safeClearInlineKeyboard,
        generateOrderWithGemini,
        systemPrompt
    });

    bot.on('text', handleTextMessage);

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
