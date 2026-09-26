/** Shared enums — kept in one place so models, validators and the UI agree. */
module.exports = {
  PRODUCT_TYPES: ['book', 'ebook', 'stationery', 'book+ebook'],

  ORDER_STATUS: [
    'pending',
    'confirmed',
    'processing',
    'ready-to-ship',
    'shipped',
    'in-transit',
    'out-for-delivery',
    'delivered',
    'cancelled',
    'returned',
    'rto',
    'failed',
  ],

  PAYMENT_METHODS: ['cod', 'prepaid'],
  PAYMENT_STATUS: ['pending', 'paid', 'failed', 'refunded'],

  BANNER_PLACEMENTS: [
    'hero',
    'desktop',
    'tablet',
    'mobile',
    'popup',
    'category',
    'subcategory',
    'offer',
    'strip',
  ],

  HOME_SECTION_TYPES: [
    'hero-slider',
    'featured-categories',
    'popular-subcategories',
    'latest-books',
    'trending-books',
    'featured-books',
    'exam-books',
    'school-books',
    'stationery',
    'best-sellers',
    'recently-added',
    'offers',
    'new-arrivals',
    'recommended',
    'banner-strip',
    'testimonials',
    'newsletter',
  ],

  COUPON_TYPES: ['percent', 'flat', 'free-shipping'],
  MEDIA_FOLDERS: ['products', 'banners', 'categories', 'ebooks', 'misc'],
};
