import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  UnauthenticatedError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../application/errors';
import { DomainError } from '../domain/errors';
import { JsonLogger, describeError } from '../shared/logger';

/**
 * One place that decides the HTTP status of every error:
 *   400 invalid payload               -> fix the request, do not resend as is
 *   401 missing or invalid token      -> get a new token
 *   403 valid token, not allowed      -> do not resend
 *   404 resource not found
 *   409 idempotency / uniqueness conflict -> never resend with this key
 *   503 transient infrastructure failure  -> safe to resend the same request
 *   500 unexpected error
 * Business rejections are not errors: they are answered with 422 by the controller.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new JsonLogger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message } = this.describe(exception);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '1');
    if (status === HttpStatus.UNAUTHORIZED) res.setHeader('WWW-Authenticate', 'Bearer');
    if (status >= 500) {
      this.logger.error('request failed', {
        code,
        correlationId: res.getHeader('X-Correlation-Id') as string | undefined,
        ...describeError(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }
    res.status(status).json({ error: { code, message } });
  }

  private describe(exception: unknown): { status: number; code: string; message: string } {
    if (exception instanceof ValidationError) {
      return { status: 400, code: exception.code, message: exception.message };
    }
    if (exception instanceof UnauthenticatedError) {
      return { status: 401, code: exception.code, message: exception.message };
    }
    if (exception instanceof ForbiddenError) {
      return { status: 403, code: exception.code, message: exception.message };
    }
    if (exception instanceof IdempotencyConflictError || exception instanceof WalletAlreadyExistsError) {
      return { status: 409, code: exception.code, message: exception.message };
    }
    if (exception instanceof NotFoundError) {
      return { status: 404, code: exception.code, message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError) {
      return { status: 503, code: exception.code, message: 'Temporary failure, retry the same request' };
    }
    if (exception instanceof DomainError) {
      // Domain validation of input (invalid money, missing reference, zero amount).
      return { status: 400, code: exception.code, message: exception.message };
    }
    if (exception instanceof ApplicationError) {
      return { status: 500, code: exception.code, message: 'Unexpected error' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
      return { status, code, message: exception.message };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected error' };
  }
}
