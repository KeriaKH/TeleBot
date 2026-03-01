function buildSafeOrderReply(items, total) {
    let text = '🧾 Bạn đã đặt:\n';

    items.forEach((item, index) => {
        const isTopping = String(item.category || '').toLowerCase() === 'topping';
        const unitPrice = item.quantity > 0 ? Math.floor(item.price / item.quantity) : item.price;
        const sizeText = isTopping ? '' : ` size ${item.size}`;
        text += `${index + 1}. ${item.name}${sizeText} x${item.quantity} - ${unitPrice.toLocaleString('vi-VN')}đ/món\n`;
        if (item.note) {
            text += `   👉 Ghi chú: ${item.note}\n`;
        }
    });

    text += `\n💵 Tổng tiền: ${total.toLocaleString('vi-VN')}đ`;
    return text;
}

function buildMotherOrderMessage(cart) {
    let message = '🚨 CÓ ĐƠN HÀNG MỚI!\n';
    message += `👤 Khách: ${cart.customerName} (@${cart.username})\n`;
    message += '📝 Chi tiết đơn:\n';

    cart.items.forEach((item, index) => {
        const isTopping = String(item.category || '').toLowerCase() === 'topping';
        const sizeText = isTopping ? '' : ` (Size ${item.size})`;
        message += `${index + 1}. ${item.name}${sizeText} x${item.quantity}\n`;
        if (item.note && item.note.trim() !== '') {
            message += `   👉 Ghi chú: ${item.note}\n`;
        }
        message += `   💰 Giá: ${item.price.toLocaleString('vi-VN')}đ\n`;
    });

    message += `\n💵 TỔNG TIỀN: ${cart.total.toLocaleString('vi-VN')}đ`;
    return message;
}

module.exports = {
    buildSafeOrderReply,
    buildMotherOrderMessage
};
