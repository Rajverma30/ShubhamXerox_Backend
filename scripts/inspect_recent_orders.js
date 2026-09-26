require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('orders');
  const latest = await col
    .find({})
    .project({
      orderNumber: 1,
      customer: 1,
      shippingAddress: 1,
      items: 1,
      total: 1,
      subtotal: 1,
      payment: 1,
      shiprocket: 1,
      createdAt: 1,
    })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  for (const o of latest) {
    console.log(
      JSON.stringify(
        {
          orderNumber: o.orderNumber,
          shiprocket: o.shiprocket,
          customer: o.customer,
          shippingAddress: o.shippingAddress,
          items: o.items,
          total: o.total,
          subtotal: o.subtotal,
          payment: o.payment,
          createdAt: o.createdAt,
        },
        null,
        2,
      ),
    );
    console.log('---');
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
