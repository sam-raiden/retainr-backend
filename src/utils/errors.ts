/**
 * Lightweight HTTP errors. Fastify's error handler (see src/server.ts)
 * reads `err.statusCode` off any thrown Error, so service-layer code can
 * just `throw new NotFoundError(...)` and the route handler doesn't need
 * its own try/catch for the common cases.
 */
export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not Found') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
    this.name = 'ConflictError';
  }
}
