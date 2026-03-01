const { MongoClient } = require('mongodb');
const { MONGO_URI } = require('./config');

let mongoClient;
let db;

async function initMongo() {
    if (db) return db;

    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('TeleBot');
    console.log('✅ Đã kết nối thành công với MongoDB Atlas!');
    return db;
}

function getDb() {
    return db;
}

module.exports = {
    initMongo,
    getDb
};
