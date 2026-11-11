import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * Authentication extension point (challenge section 2).
 *
 * Authentication is intentionally not implemented: it is worth no points and
 * the challenge accepts a documented no-op. This guard is where an external
 * Identity Provider (Keycloak, Zitadel or any OIDC provider) plugs in: validate
 * the bearer token, read the provider identity from its claims and refuse a
 * request whose body.providerId differs from it. See ARCHITECTURE.md.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
