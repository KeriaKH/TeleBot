const { getFormattedMenu, isMenuIntent } = require('../services/menuService');
const {
    sanitizeAndRecalculateItems,
    trimChatHistory,
    buildAssistantStateMessage,
    isSameOrder
} = require('../services/orderService');
const { buildSafeOrderReply } = require('../services/messageService');
const { AI_TIMEOUT_MS, parseOrderData, withTimeout } = require('../services/aiOrderService');

function createTextMessageHandler({
    menuData,
    menuPriceMap,
    userCarts,
    chatSessions,
    lastActiveButtons,
    orderActions,
    isOwnerUser,
    safeDeleteMessage,
    safeClearInlineKeyboard,
    generateOrderWithGemini,
    systemPrompt
}) {
    async function replyCurrentCartOrFallback(ctx, userId, fallbackMessage) {
        const currentCart = userCarts[userId];
        if (!currentCart || !Array.isArray(currentCart.items) || currentCart.items.length === 0) {
            await ctx.reply(fallbackMessage);
            return;
        }

        await ctx.reply('Mình đang gặp chút trục trặc khi xử lý câu vừa rồi, mình giữ nguyên đơn hiện tại của bạn nhé 👇');
        await safeClearInlineKeyboard(ctx, lastActiveButtons[userId]);
        const receipt = buildSafeOrderReply(currentCart.items, currentCart.total);
        const sentMsg = await ctx.reply(receipt, orderActions);
        lastActiveButtons[userId] = sentMsg.message_id;
    }

    return async function handleTextMessage(ctx) {
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
                chatSessions[userId] = [{ role: 'system', content: systemPrompt }];
            }

            chatSessions[userId].push({ role: 'user', content: userMessage });
            trimChatHistory(chatSessions[userId]);

            const responseText = await withTimeout(
                generateOrderWithGemini(chatSessions[userId]),
                AI_TIMEOUT_MS,
                'AI request timeout'
            );
            const orderData = parseOrderData(responseText);

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

                    const sentMsg = await ctx.reply(safeReplyMessage, orderActions);
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

            if (error?.name === 'TimeoutError') {
                await replyCurrentCartOrFallback(
                    ctx,
                    userId,
                    'Quán đang hơi đông nên phản hồi chậm một chút 😥 Bạn nhắn lại giúp mình hoặc gõ “xem đơn hàng” để kiểm tra đơn hiện tại nhé.'
                );
                return;
            }

            if (error?.name === 'JsonParseError' || String(error?.message || '').includes('JSON_PARSE_ERROR')) {
                await replyCurrentCartOrFallback(
                    ctx,
                    userId,
                    'Mình chưa đọc kịp nội dung đơn vừa rồi. Bạn nhắn lại ngắn gọn hơn giúp mình hoặc gõ “xem đơn hàng” nhé.'
                );
                return;
            }

            await ctx.reply('Xin lỗi bạn, quán đang quá tải tin nhắn. Bạn vui lòng nhắn lại giúp quán nhé!');
        }
    };
}

module.exports = {
    createTextMessageHandler
};
