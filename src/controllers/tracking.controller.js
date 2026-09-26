/**
 * Order tracking — proxied straight to Shiprocket.
 *
 * This store does not persist orders: checkout happens inside Shiprocket
 * Checkout, so Shiprocket is the system of record. The Track Order page sends
 * whatever reference the customer has (the order number from their Shiprocket
 * confirmation, or an AWB from the courier SMS) and we look it up live.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/response');
const shiprocket = require('../services/shiprocket.service');
const logger = require('../utils/logger');

const STATUS_ORDER = [
  'confirmed', 'processing', 'ready-to-ship', 'shipped',
  'in-transit', 'out-for-delivery', 'delivered',
];

/** GET /api/track?order=<orderNumber>  |  ?awb=<awb> */
exports.track = asyncHandler(async (req, res) => {
  const awb = String(req.query.awb || '').trim();
  const orderId = String(req.query.order || req.query.order_id || '').trim();

  if (!awb && !orderId) {
    throw ApiError.badRequest('Enter your order number or AWB number');
  }
  if (!shiprocket.credentialsPresent()) {
    throw ApiError.internal('Order tracking is unavailable right now. Please contact us and we will check for you.');
  }

  let live;
  try {
    live = awb ? await shiprocket.trackByAwb(awb) : await shiprocket.trackByOrderId(orderId);
  } catch (err) {
    logger.warn(`Tracking lookup failed for ${awb || orderId}: ${err.message}`);
    throw ApiError.notFound(
      "We couldn't find a shipment for that reference. Double-check the number, or note that tracking " +
      'only appears once your parcel has been picked up.',
    );
  }

  if (!live?.currentStatus || live.currentStatus === 'Unknown') {
    throw ApiError.notFound(
      'No tracking information yet. Orders usually appear here within a few hours of being dispatched.',
    );
  }

  const status = shiprocket.mapStatus(live.currentStatus);

  return ok(res, {
    reference: awb || orderId,
    status,
    statusLabel: live.currentStatus,
    stage: Math.max(0, STATUS_ORDER.indexOf(status)),
    stages: STATUS_ORDER,
    awb: live.awb || awb || null,
    courierName: live.courierName,
    etd: live.etd,
    trackUrl: live.trackUrl,
    activities: live.activities || [],
  });
});

/**
 * GET /api/shipping/serviceability?pincode=
 * Powers the "check delivery to your area" box on the product page.
 */
exports.serviceability = asyncHandler(async (req, res) => {
  if (!/^\d{6}$/.test(String(req.query.pincode || ''))) {
    throw ApiError.badRequest('Enter a valid 6-digit PIN code');
  }
  let data;
  if (shiprocket.credentialsPresent()) {
    try {
      data = await shiprocket.checkServiceability({
        deliveryPincode: req.query.pincode,
        weight: Number(req.query.weight) || 0.5,
        cod: req.query.cod === 'true' ? 1 : 0,
        declaredValue: Number(req.query.value) || 0,
      });
    } catch (err) {
      logger.warn(`Shiprocket serviceability lookup failed: ${err.message}`);
    }
  }

  // Always force delivery available for all pincodes
  if (!data || !data.serviceable) {
    data = {
      serviceable: true,
      couriers: [
        { courierCompanyId: 'std_express', name: 'Express Shipping', rate: 0, etd: '3–5 days', estimatedDeliveryDays: '3–5', codAvailable: true }
      ],
      cheapest: { courierCompanyId: 'std_express', name: 'Express Shipping', rate: 0 },
      etd: '3–5 business days',
      message: 'Delivery available',
    };
  } else {
    data.serviceable = true;
  }

  return ok(res, data);
});
