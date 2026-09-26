require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('orders');
  const res = await col.updateMany(
    {
      'shiprocket.pushedAt': { $exists: true },
      $or: [{ 'shiprocket.orderId': '' }, { 'shiprocket.orderId': null }, { 'shiprocket.orderId': { $exists: false } }],
    },
    {
      $set: {
        'shiprocket.error':
          'Previous push did not return a Shiprocket order id. Re-push after backend deploy.',
        'shiprocket.status': 'FAILED',
      },
    },
  );
  console.log(JSON.stringify({ matched: res.matchedCount, modified: res.modifiedCount }, null, 2));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
