const { normalizeTextKey } = require('../utils/text');
const { MAX_HISTORY_MESSAGES } = require('../config');

function sanitizeAndRecalculateItems(rawItems = [], menuPriceMap) {
    const safeItems = [];
    let safeTotal = 0;

    rawItems.forEach(rawItem => {
        const quantityValue = Number(rawItem?.quantity);
        const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? Math.floor(quantityValue) : 1;

        const requestedSize = String(rawItem?.size || 'M').trim().toUpperCase();
        const size = requestedSize === 'L' ? 'L' : 'M';

        const rawName = String(rawItem?.name || '').trim();
        const menuEntry = menuPriceMap.get(normalizeTextKey(rawName));

        const name = menuEntry?.name || rawName || 'Món không rõ';

        let unitPrice = 0;
        if (menuEntry) {
            unitPrice = size === 'L' ? menuEntry.price_l : menuEntry.price_m;
        } else {
            const fallbackPrice = Number(rawItem?.price);
            unitPrice = Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? Math.floor(fallbackPrice) : 0;
        }

        const lineTotal = unitPrice * quantity;
        safeTotal += lineTotal;

        safeItems.push({
            name,
            category: menuEntry?.category || '',
            size,
            quantity,
            note: typeof rawItem?.note === 'string' ? rawItem.note.trim() : '',
            price: lineTotal
        });
    });

    return { items: safeItems, total: safeTotal };
}

function trimChatHistory(session) {
    if (session.length <= MAX_HISTORY_MESSAGES) {
        return;
    }

    const systemMessage = session[0];
    const recentMessages = session.slice(-(MAX_HISTORY_MESSAGES - 1));
    session.length = 0;
    session.push(systemMessage, ...recentMessages);
}

function buildAssistantStateMessage(items, total) {
    return `STATE_CART: ${JSON.stringify({ items, total })}`;
}

function buildOrderSignature(order) {
    if (!order || !Array.isArray(order.items)) return '';
    const normalizedItems = order.items
        .map(item => ({
            name: normalizeTextKey(item.name),
            size: String(item.size || 'M').toUpperCase() === 'L' ? 'L' : 'M',
            quantity: Number(item.quantity) || 1,
            note: String(item.note || '').trim(),
            price: Number(item.price) || 0
        }))
        .sort((a, b) => {
            const left = `${a.name}|${a.size}|${a.note}|${a.price}|${a.quantity}`;
            const right = `${b.name}|${b.size}|${b.note}|${b.price}|${b.quantity}`;
            return left.localeCompare(right);
        });

    return JSON.stringify({ items: normalizedItems, total: Number(order.total) || 0 });
}

function isSameOrder(leftOrder, rightOrder) {
    return buildOrderSignature(leftOrder) === buildOrderSignature(rightOrder);
}

module.exports = {
    sanitizeAndRecalculateItems,
    trimChatHistory,
    buildAssistantStateMessage,
    buildOrderSignature,
    isSameOrder
};
