export type ErrorDetails = Record<string, unknown> | unknown[];

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequest extends AppError {
  constructor(code = 'BAD_REQUEST', message = 'Bad request', details?: ErrorDetails) {
    super(400, code, message, details);
  }
}

export class Unauthorized extends AppError {
  constructor(code = 'UNAUTHORIZED', message = 'Authentication required', details?: ErrorDetails) {
    super(401, code, message, details);
  }
}

export class PlanLimit extends AppError {
  constructor(code = 'PLAN_LIMIT_REACHED', message = 'Your plan limit has been reached', details?: ErrorDetails) {
    super(402, code, message, details);
  }
}

export class Forbidden extends AppError {
  constructor(code = 'FORBIDDEN', message = 'You do not have permission to do this', details?: ErrorDetails) {
    super(403, code, message, details);
  }
}

export class NotFound extends AppError {
  constructor(code = 'NOT_FOUND', message = 'Not found', details?: ErrorDetails) {
    super(404, code, message, details);
  }
}

export class Conflict extends AppError {
  constructor(code = 'CONFLICT', message = 'Conflict', details?: ErrorDetails) {
    super(409, code, message, details);
  }
}

export class Gone extends AppError {
  constructor(code = 'GONE', message = 'No longer available', details?: ErrorDetails) {
    super(410, code, message, details);
  }
}

export class Locked extends AppError {
  constructor(code = 'LOCKED', message = 'Locked', details?: ErrorDetails) {
    super(423, code, message, details);
  }
}

export class TooManyRequests extends AppError {
  constructor(code = 'TOO_MANY_REQUESTS', message = 'Too many requests', details?: ErrorDetails) {
    super(429, code, message, details);
  }
}
