import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../application/errors';
import { config } from '../shared/config';
import { TokenVerifier, type Identity } from './token-verifier';

const OPERATOR_ONLY = 'auth:operator-only';

/** Marks an endpoint that only operators may call (wallet creation, reconciliation). */
export const OperatorOnly = () => SetMetadata(OPERATOR_ONLY, true);

type AuthenticatedRequest = Request & { identity?: Identity };

/**
 * Authentication and authorization of the business endpoints.
 *
 * With AUTH_ENABLED=true every request needs a bearer token issued by the
 * external Identity Provider. A provider may only act for its own providerId
 * (taken from the token, never trusted from the request); operators may act
 * for any provider and are the only ones allowed on @OperatorOnly endpoints.
 *
 * With AUTH_ENABLED=false (default for local development and tests) the guard
 * lets everything through.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!config.auth.enabled()) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match) throw new UnauthenticatedError();
    const identity = await this.verifier.verify(match[1]);

    if (!identity.operator && !identity.providerId) {
      throw new ForbiddenError('The token carries no provider identity');
    }
    const operatorOnly = this.reflector.getAllAndOverride<boolean>(OPERATOR_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (operatorOnly && !identity.operator) {
      throw new ForbiddenError('Only operators may perform this operation');
    }
    // The providerId in the route or in the body must be the caller's own.
    const body = req.body as { providerId?: unknown } | undefined;
    const requested = [req.params?.providerId, body?.providerId].filter(
      (value): value is string => typeof value === 'string',
    );
    if (!identity.operator && requested.some((providerId) => providerId !== identity.providerId)) {
      throw new ForbiddenError('A provider can only act for its own providerId');
    }

    req.identity = identity;
    return true;
  }
}

/**
 * For resources loaded by id: a provider must not see another provider's
 * transaction. Answers "not found" so that ids cannot be probed.
 */
export function assertCanSeeProvider(req: Request, providerId: string): void {
  const identity = (req as AuthenticatedRequest).identity;
  if (identity && !identity.operator && identity.providerId !== providerId) {
    throw new NotFoundError('Transaction');
  }
}
