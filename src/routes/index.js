/** Route table. Public storefront routes first, then the admin namespace. */
const express = require('express');

const router = express.Router();

// Legacy URL resolution — keeps the old site's product links alive.
router.get('/legacy/resolve', require('../utils/asyncHandler')(require('../controllers/legacy.controller').resolve));

router.use('/', require('./public.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
