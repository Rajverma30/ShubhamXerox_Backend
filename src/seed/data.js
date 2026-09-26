/** Demo catalogue used by `npm run seed`. Safe to delete in production. */

const categories = [
  {
    name: 'Exam Books',
    icon: 'FiAward',
    color: '#4f46e5',
    order: 1,
    isFeatured: true,
    shortDescription: 'Curated guides, previous papers and practice sets for every competitive exam.',
    description:
      '<p>From SSC and UPSC to Railway, Banking and OSSC — every title we stock is hand-picked by teachers who have cleared the exam themselves.</p>',
    subs: [
      { name: 'Police', isPopular: true },
      { name: 'SSC', isPopular: true },
      { name: 'UPSC', isPopular: true },
      { name: 'IAS', isPopular: true },
      { name: 'Railway', isPopular: true },
      { name: 'Banking', isPopular: true },
      { name: 'CTET', isPopular: false },
      { name: 'OSSC', isPopular: true },
      { name: 'OPSC', isPopular: false },
    ],
  },
  {
    name: 'School Books',
    icon: 'FiBookOpen',
    color: '#0ea5e9',
    order: 2,
    isFeatured: true,
    shortDescription: 'Class 1 to Class 12 textbooks, workbooks and reference guides.',
    description: '<p>Board-aligned textbooks, solved question banks and workbooks for every class.</p>',
    subs: Array.from({ length: 12 }, (_, i) => ({ name: `Class ${i + 1}`, isPopular: i + 1 >= 8 })),
  },
  {
    name: 'Stationery',
    icon: 'FiEdit3',
    color: '#f59e0b',
    order: 3,
    isFeatured: true,
    shortDescription: 'Pens, notebooks, files and art supplies that actually feel good to use.',
    description: '<p>Everything for the desk — writing, filing, drawing and office essentials.</p>',
    subs: [
      { name: 'Pen', isPopular: true },
      { name: 'Pencil', isPopular: true },
      { name: 'Notebook', isPopular: true },
      { name: 'File', isPopular: false },
      { name: 'Register', isPopular: true },
      { name: 'Drawing', isPopular: false },
      { name: 'Art Supplies', isPopular: false },
      { name: 'Office Supplies', isPopular: true },
    ],
  },
  {
    name: 'Competitive Magazines',
    icon: 'FiTrendingUp',
    color: '#10b981',
    order: 4,
    isFeatured: false,
    shortDescription: 'Monthly current-affairs digests and yearbooks.',
    subs: [{ name: 'Current Affairs', isPopular: true }, { name: 'Yearbook', isPopular: false }],
  },
];

/** [title, author, publisher, category, subcategory, price, discount%, stock, lang, pages] */
const books = [
  ['Odisha Police Constable Complete Guide 2026', 'Dr. S. K. Mishra', 'Subham Publications', 'Exam Books', 'Police', 480, 25, 40, 'English', 728],
  ['SSC CGL Tier-I & Tier-II Master Practice Sets', 'Rakesh Yadav', 'Arihant', 'Exam Books', 'SSC', 599, 30, 55, 'English', 892],
  ['UPSC Civil Services Prelims General Studies', 'M. Laxmikanth', 'McGraw Hill', 'Exam Books', 'UPSC', 850, 18, 25, 'English', 1024],
  ['Indian Polity for IAS Aspirants', 'M. Laxmikanth', 'McGraw Hill', 'Exam Books', 'IAS', 780, 20, 30, 'English', 960],
  ['RRB NTPC Complete Study Package', 'Kiran Editorial', 'Kiran Prakashan', 'Exam Books', 'Railway', 545, 28, 48, 'English', 812],
  ['IBPS PO Quantitative Aptitude Simplified', 'R. S. Aggarwal', 'S. Chand', 'Exam Books', 'Banking', 495, 22, 36, 'English', 640],
  ['CTET Paper-I & II Solved Papers', 'Arihant Experts', 'Arihant', 'Exam Books', 'CTET', 420, 15, 22, 'Hindi', 528],
  ['OSSC Combined Recruitment Guide', 'Subham Editorial', 'Subham Publications', 'Exam Books', 'OSSC', 460, 26, 44, 'Odia', 604],
  ['OPSC OAS Prelims Companion', 'B. K. Panda', 'Subham Publications', 'Exam Books', 'OPSC', 690, 20, 18, 'English', 744],
  ['General Knowledge Yearbook 2026', 'Manohar Pandey', 'Arihant', 'Competitive Magazines', 'Yearbook', 350, 30, 90, 'English', 448],
  ['Monthly Current Affairs Digest — July 2026', 'Editorial Board', 'Subham Publications', 'Competitive Magazines', 'Current Affairs', 90, 10, 150, 'English', 96],
  ['Mathematics Class 10 Textbook & Solutions', 'NCERT', 'NCERT', 'School Books', 'Class 10', 260, 12, 120, 'English', 384],
  ['Science Class 9 Complete Reference', 'Lakhmir Singh', 'S. Chand', 'School Books', 'Class 9', 340, 18, 88, 'English', 456],
  ['English Grammar & Composition Class 8', 'Wren & Martin', 'S. Chand', 'School Books', 'Class 8', 295, 15, 76, 'English', 372],
  ['Physics Class 12 Volume I & II', 'H. C. Verma', 'Bharati Bhawan', 'School Books', 'Class 12', 640, 20, 42, 'English', 848],
  ['Chemistry Class 11 Study Guide', 'P. Bahadur', 'Bharati Bhawan', 'School Books', 'Class 11', 520, 17, 38, 'English', 692],
  ['Odia Sahitya Class 7', 'State Board', 'Odisha Board', 'School Books', 'Class 7', 180, 10, 64, 'Odia', 240],
  ['Environmental Studies Class 5', 'NCERT', 'NCERT', 'School Books', 'Class 5', 150, 8, 95, 'English', 176],
  ['Hindi Vyakaran Class 6', 'Dr. Anita Sharma', 'Rajpal', 'School Books', 'Class 6', 210, 14, 58, 'Hindi', 268],
  ['Reasoning & Aptitude Crash Course', 'Rakesh Yadav', 'Arihant', 'Exam Books', 'SSC', 380, 35, 62, 'English', 496],
];

/** [title, brand, subcategory, price, discount%, stock, color] */
const stationery = [
  ['Uni-ball Eye Fine Rollerball Pen (Pack of 5)', 'Uni-ball', 'Pen', 375, 20, 140, 'Blue'],
  ['Parker Vector Stainless Steel Ball Pen', 'Parker', 'Pen', 690, 15, 45, 'Silver'],
  ['Apsara Platinum Extra Dark Pencils (Pack of 10)', 'Apsara', 'Pencil', 120, 18, 220, 'Black'],
  ['Classmate Long Notebook 172 Pages (Pack of 6)', 'Classmate', 'Notebook', 480, 22, 160, 'Assorted'],
  ['Premium A4 Ruled Register 300 Pages', 'Subham', 'Register', 260, 12, 110, 'Navy'],
  ['Solo Executive Clip File A4 (Set of 3)', 'Solo', 'File', 330, 25, 85, 'Grey'],
  ['Camlin Kokuyo Drawing Kit 24 Shades', 'Camlin', 'Drawing', 420, 20, 70, 'Multicolour'],
  ['Faber-Castell Acrylic Colour Set 12x9ml', 'Faber-Castell', 'Art Supplies', 640, 18, 38, 'Multicolour'],
  ['Sticky Notes Pastel Cube 400 Sheets', 'Subham', 'Office Supplies', 190, 15, 200, 'Pastel'],
  ['Heavy-duty Stapler with 5000 Pins', 'Kangaro', 'Office Supplies', 350, 20, 65, 'Black'],
  ['Geometry Box Complete Set', 'Camlin', 'Drawing', 240, 16, 120, 'Blue'],
  ['Highlighter Pastel Set of 6', 'Doms', 'Pen', 210, 24, 180, 'Pastel'],
];

const coupons = [
  { code: 'WELCOME10', description: '10% off your first order', type: 'percent', value: 10, maxDiscount: 150, minOrderValue: 499 },
  { code: 'EXAM50', description: 'Flat ₹50 off on exam books above ₹699', type: 'flat', value: 50, minOrderValue: 699 },
  { code: 'FREESHIP', description: 'Free delivery, no minimum', type: 'free-shipping', value: 0, minOrderValue: 0 },
  { code: 'SUBHAM15', description: '15% off site-wide, up to ₹300', type: 'percent', value: 15, maxDiscount: 300, minOrderValue: 999 },
];

const banners = [
  {
    placement: 'hero',
    eyebrow: 'New session 2026',
    title: 'Every exam guide you need, in one shelf',
    subtitle: 'Police · SSC · UPSC · Railway · Banking — up to 35% off this week.',
    buttonText: 'Shop exam books',
    buttonUrl: '/category/exam-books',
    secondaryButtonText: 'Browse all',
    secondaryButtonUrl: '/shop',
    priority: 100,
    theme: 'dark',
    gradient: ['#1e1b4b', '#4f46e5'],
  },
  {
    placement: 'hero',
    eyebrow: 'Back to school',
    title: 'Class 1 to 12, sorted before day one',
    subtitle: 'Board-aligned textbooks, workbooks and reference guides.',
    buttonText: 'Shop school books',
    buttonUrl: '/category/school-books',
    priority: 90,
    theme: 'dark',
    gradient: ['#082f49', '#0ea5e9'],
  },
  {
    placement: 'hero',
    eyebrow: 'Desk upgrade',
    title: 'Stationery that feels as good as it writes',
    subtitle: 'Pens, notebooks and art supplies from brands you trust.',
    buttonText: 'Shop stationery',
    buttonUrl: '/category/stationery',
    priority: 80,
    theme: 'dark',
    gradient: ['#451a03', '#f59e0b'],
  },
  {
    placement: 'offer',
    title: 'Free ebook with every guide',
    subtitle: 'Buy the print copy, download the PDF instantly.',
    buttonText: 'See titles',
    buttonUrl: '/ebooks',
    priority: 50,
    gradient: ['#064e3b', '#10b981'],
  },
  {
    placement: 'offer',
    title: 'Free delivery above ₹499',
    subtitle: 'Shipped across India with Shiprocket.',
    buttonText: 'Start shopping',
    buttonUrl: '/shop',
    priority: 40,
    gradient: ['#3b0764', '#a855f7'],
  },
];

const homeSections = [
  { key: 'hero', type: 'hero-slider', order: 1, layout: 'banner' },
  { key: 'featured-categories', type: 'featured-categories', title: 'Shop by category', subtitle: 'Find your shelf in one tap', order: 2, layout: 'grid', limit: 8 },
  { key: 'latest-books', type: 'latest-books', title: 'Just landed', subtitle: 'The newest titles on our shelves', viewAllUrl: '/shop?sort=newest', order: 3, layout: 'carousel', limit: 12 },
  { key: 'trending-books', type: 'trending-books', title: 'Trending this week', subtitle: 'What aspirants are buying right now', viewAllUrl: '/shop?isTrending=true', order: 4, layout: 'carousel', limit: 12 },
  { key: 'offer-strip', type: 'banner-strip', order: 5, layout: 'banner', bannerPlacement: 'offer', limit: 2 },
  { key: 'exam-books', type: 'exam-books', title: 'Exam books', subtitle: 'Guides, practice sets and previous papers', categorySlug: 'exam-books', viewAllUrl: '/category/exam-books', order: 6, layout: 'carousel', limit: 12 },
  { key: 'school-books', type: 'school-books', title: 'School books', subtitle: 'Class 1 to Class 12', categorySlug: 'school-books', viewAllUrl: '/category/school-books', order: 7, layout: 'carousel', limit: 12 },
  { key: 'stationery', type: 'stationery', title: 'Stationery', subtitle: 'Desk essentials worth keeping', categorySlug: 'stationery', viewAllUrl: '/category/stationery', order: 8, layout: 'carousel', limit: 12 },
  { key: 'popular-subcategories', type: 'popular-subcategories', title: 'Popular collections', subtitle: 'Jump straight to what you need', order: 9, layout: 'grid', limit: 16 },
  { key: 'best-sellers', type: 'best-sellers', title: 'Best sellers', subtitle: 'Loved by thousands of students', viewAllUrl: '/shop?sort=best-selling', order: 10, layout: 'carousel', limit: 12, sort: 'best-selling' },
  { key: 'offers', type: 'offers', title: 'Biggest discounts', subtitle: 'Up to 35% off, while stocks last', viewAllUrl: '/offers', order: 11, layout: 'carousel', limit: 12, sort: 'discount' },
  { key: 'featured-books', type: 'featured-books', title: 'Featured picks', subtitle: 'Hand-picked by our team', order: 12, layout: 'grid', limit: 8 },
  { key: 'recently-added', type: 'recently-added', title: 'Recently added', viewAllUrl: '/shop?sort=newest', order: 13, layout: 'carousel', limit: 12, sort: 'newest' },
  { key: 'recommended', type: 'recommended', title: 'Recommended for you', subtitle: 'Based on what students browse most', order: 14, layout: 'carousel', limit: 12, sort: 'popular' },
  { key: 'testimonials', type: 'testimonials', title: 'What our customers say', order: 15, layout: 'carousel' },
  { key: 'newsletter', type: 'newsletter', title: 'Get new arrivals first', subtitle: 'One email a week. No spam, ever.', order: 16, layout: 'banner' },
];

const testimonials = [
  { name: 'Ananya Patra', role: 'OSSC aspirant, Cuttack', rating: 5, text: 'Ordered three guides on a Tuesday and had them by Thursday. The free ebook meant I could start revising the same evening.' },
  { name: 'Rohit Sahoo', role: 'Class 12 student', rating: 5, text: 'Cheaper than my local shop and the packaging was spotless. The whole checkout took under a minute — no account needed.' },
  { name: 'Sunita Das', role: 'Teacher, Bhubaneswar', rating: 5, text: 'I order registers and files for my whole classroom here every term. Reliable stock and honest pricing.' },
  { name: 'Debasis Nayak', role: 'Railway exam aspirant', rating: 4, text: 'The practice sets are genuinely the latest edition. Tracking updates came through on WhatsApp and email.' },
  { name: 'Priya Mohanty', role: 'Parent', rating: 5, text: "Found every book on my daughter's Class 8 list in one order. That has never happened before." },
];

const popularSearches = [
  'ssc cgl', 'upsc prelims', 'class 10 maths', 'odisha police', 'current affairs 2026',
  'ncert science', 'notebook pack', 'railway ntpc', 'ctet paper 1', 'drawing kit',
];

const footerLinks = [
  { group: 'Shop', label: 'All products', url: '/shop' },
  { group: 'Shop', label: 'Exam books', url: '/category/exam-books' },
  { group: 'Shop', label: 'School books', url: '/category/school-books' },
  { group: 'Shop', label: 'Stationery', url: '/category/stationery' },
  { group: 'Shop', label: 'Free ebooks', url: '/ebooks' },
  { group: 'Help', label: 'Track your order', url: '/track' },
  { group: 'Help', label: 'Shipping & delivery', url: '/policy/shipping' },
  { group: 'Help', label: 'Returns & refunds', url: '/policy/returns' },
  { group: 'Help', label: 'Contact us', url: '/contact' },
  { group: 'Company', label: 'About Shubham Xerox', url: '/about' },
  { group: 'Company', label: 'Privacy policy', url: '/policy/privacy' },
  { group: 'Company', label: 'Terms of service', url: '/policy/terms' },
];

module.exports = { categories, books, stationery, coupons, banners, homeSections, testimonials, popularSearches, footerLinks };
