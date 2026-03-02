const { GoogleGenerativeAI } = require('@google/generative-ai');
const { buildSystemPrompt } = require('./promptService');

const AI_TIMEOUT_MS = 15000;

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

function normalizeLikelyJson(jsonText) {
    let normalized = String(jsonText || '').trim();
    if (!normalized) return normalized;

    normalized = normalized
        .replace(/^\uFEFF/, '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

    if (normalized.includes("'")) {
        normalized = normalized.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => {
            const escaped = inner.replace(/\"/g, '"').replace(/"/g, '\\"');
            return `"${escaped}"`;
        });
    }

    return normalized;
}

function parseOrderData(rawText) {
    const extracted = extractJsonString(rawText);

    try {
        return JSON.parse(extracted);
    } catch (firstError) {
        const normalized = normalizeLikelyJson(extracted);
        try {
            return JSON.parse(normalized);
        } catch (secondError) {
            const parseError = new Error(`JSON_PARSE_ERROR: ${secondError.message}`);
            parseError.name = 'JsonParseError';
            throw parseError;
        }
    }
}

async function withTimeout(promise, timeoutMs, timeoutMessage = 'TIMEOUT') {
    let timer;
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(timeoutMessage);
                err.name = 'TimeoutError';
                reject(err);
            }, timeoutMs);
        });

        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

function createAiOrderService({ apiKey, menuData }) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const systemPrompt = buildSystemPrompt(menuData);

    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
        },
        systemInstruction: systemPrompt
    });

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

    return {
        systemPrompt,
        generateOrderWithGemini
    };
}

module.exports = {
    AI_TIMEOUT_MS,
    createAiOrderService,
    parseOrderData,
    withTimeout
};
