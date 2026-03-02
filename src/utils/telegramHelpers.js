const { MOTHER_ID } = require('../config');

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

module.exports = {
    safeDeleteMessage,
    safeClearInlineKeyboard,
    isOwnerUser
};
