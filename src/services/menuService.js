const fs = require('fs');
const path = require('path');
const { normalizeTextKey } = require('../utils/text');

function loadMenuData() {
    const menuPath = path.resolve(__dirname, '..', '..', 'menu.json');
    return JSON.parse(fs.readFileSync(menuPath, 'utf8'));
}

function buildMenuPriceMap(menuData) {
    const menuPriceMap = new Map();

    menuData.forEach(category => {
        category.items.forEach(item => {
            menuPriceMap.set(normalizeTextKey(item.name), {
                name: item.name,
                price_m: item.price_m,
                price_l: item.price_l
            });
        });
    });

    return menuPriceMap;
}

function getFormattedMenu(menuData) {
    let text = "📋 *MENU QUÁN TRÀ SỮA*\n\n";
    menuData.forEach(cat => {
        text += `*--- ${cat.category.toUpperCase()} ---*\n`;
        cat.items.forEach(item => {
            if (cat.category === 'Topping') {
                text += `- ${item.name}: ${item.price_m / 1000}k\n`;
            } else {
                text += `- ${item.name}: ${item.price_m / 1000}k (M) / ${item.price_l / 1000}k (L)\n`;
            }
        });
        text += '\n';
    });
    text += '💬 Bạn muốn uống gì cứ nhắn tự nhiên nhé!';
    return text;
}

function isMenuIntent(message) {
    const text = normalizeTextKey(message);
    if (!text) return false;

    return (
        text === 'menu' ||
        text.includes('thuc don') ||
        text.includes('xem menu') ||
        text.includes('co mon gi') ||
        text.includes('quan co mon gi')
    );
}

module.exports = {
    loadMenuData,
    buildMenuPriceMap,
    getFormattedMenu,
    isMenuIntent
};
