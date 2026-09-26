/** Operational error carrying an HTTP status code. */
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
  static badRequest(m = 'Bad request', d) { return new ApiError(400, m, d); }
  static unauthorized(m = 'Not authenticated') { return new ApiError(401, m); }
  static forbidden(m = 'Not allowed') { return new ApiError(403, m); }
  static notFound(m = 'Resource not found') { return new ApiError(404, m); }
  static conflict(m = 'Already exists') { return new ApiError(409, m); }
  static unprocessable(m = 'Validation failed', d) { return new ApiError(422, m, d); }
  static tooMany(m = 'Too many requests') { return new ApiError(429, m); }
  static badGateway(m = 'Upstream service failed') { return new ApiError(502, m); }
  static internal(m = 'Something went wrong') { return new ApiError(500, m); }
}
module.exports = ApiError;
