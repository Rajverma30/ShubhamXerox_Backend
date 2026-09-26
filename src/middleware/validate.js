const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

/** Collects express-validator errors into a 422 response. */
module.exports = (req, _res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  return next(
    ApiError.unprocessable(
      'Validation failed',
      result.array().map((e) => ({ field: e.path, message: e.msg })),
    ),
  );
};
