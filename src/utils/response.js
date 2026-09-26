/** Uniform success envelope so both frontends can parse responses blindly. */
exports.ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
exports.created = (res, data, extra = {}) => res.status(201).json({ success: true, data, ...extra });
exports.paginated = (res, items, { page, limit, total }, extra = {}) =>
  res.status(200).json({
    success: true,
    data: items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
    ...extra,
  });
