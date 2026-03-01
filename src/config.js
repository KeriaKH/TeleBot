require('dotenv').config();

module.exports = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    MONGO_URI: process.env.MONGO_URI,
    MOTHER_ID: process.env.MOTHER_ID
};
