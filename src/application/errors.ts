/** Errors of the application layer. The HTTP filter maps each one to a status code. */
export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The payload is malformed: fix it before sending again. */
export class ValidationError extends ApplicationError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

/** Same idempotency key (or provider transaction) with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different payload');
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor() {
    super('WALLET_ALREADY_EXISTS', 'This player already has a wallet in this currency');
  }
}

export class NotFoundError extends ApplicationError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

/** Temporary infrastructure problem: the same request can be sent again later. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSIENT_FAILURE', message);
    this.cause = options?.cause;
  }
}

/** A unique constraint refused a write. Raised by the persistence adapter. */
export class UniqueViolationError extends ApplicationError {
  constructor(public readonly constraint: string) {
    super('UNIQUE_VIOLATION', `Unique constraint violated: ${constraint}`);
  }
}
