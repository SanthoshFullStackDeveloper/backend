const admin = require('firebase-admin');
const serviceAccount = require('./georgehospitality-1fe8e-firebase-adminsdk-fbsvc-0ce7b11c57.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
module.exports = db;