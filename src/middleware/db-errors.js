import { IdValidationError } from '../lib/ids.js';

const PG_MESSAGES = {
  '23505': { status: 409, message: 'Resource already exists' },
  '23503': { status: 400, message: 'Referenced resource does not exist' },
  '22P02': { status: 400, message: 'Invalid ID or data format' },
  '42883': { status: 400, message: 'Invalid ID type for database column' },
  '42703': { status: 500, message: 'Database schema mismatch — run migrations' },
};

function safeQuerySnippet(err) {
  if (!err.query || process.env.NODE_ENV === 'production') return undefined;
  return String(err.query).slice(0, 300);
}

export function logDbFailure(err, context = {}) {
  console.error('[DB]', {
    code: err.code,
    message: err.message,
    detail: err.detail,
    table: err.table,
    column: err.column,
    ...context,
    query: safeQuerySnippet(err),
    params: process.env.NODE_ENV !== 'production' ? err.parameters : undefined,
  });
}

export function mapPgError(err) {
  if (err instanceof IdValidationError) {
    return { status: err.statusCode, body: { error: err.message, code: 'INVALID_ID' } };
  }

  if (err.code && PG_MESSAGES[err.code]) {
    const mapped = PG_MESSAGES[err.code];
    return {
      status: mapped.status,
      body: {
        error: mapped.message,
        code: err.code,
        ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
      },
    };
  }

  return null;
}

export function handleDbError(err, req, res, next) {
  logDbFailure(err, { path: req.path, method: req.method });

  const mapped = mapPgError(err);
  if (mapped) {
    return res.status(mapped.status).json(mapped.body);
  }

  next(err);
}

/** Wrap async route handlers — forwards errors to Express error middleware */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
