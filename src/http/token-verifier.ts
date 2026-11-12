import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { TransientInfrastructureError, UnauthenticatedError } from '../application/errors';
import { config } from '../shared/config';

/** Who is calling, according to a verified token. */
export interface Identity {
  subject: string;
  /** Set for a game provider: the only providerId this caller may act for. */
  providerId?: string;
  /** Operators manage wallets and may act for any provider. */
  operator: boolean;
}

/** Only asymmetric algorithms: the API never holds a signing secret. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

/**
 * Verifies access tokens issued by the external Identity Provider (OIDC).
 * The signature is checked against the provider's published keys (JWKS), which
 * are fetched on first use and cached, so no secret is stored in this service.
 */
@Injectable()
export class TokenVerifier {
  private keys?: ReturnType<typeof createRemoteJWKSet>;

  async verify(token: string): Promise<Identity> {
    this.keys ??= createRemoteJWKSet(new URL(config.auth.jwksUrl()), { timeoutDuration: 3_000 });
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: config.auth.issuer(),
        audience: config.auth.audience(),
        algorithms: ALGORITHMS,
      });
      return {
        subject: String(payload.sub ?? payload.azp ?? 'unknown'),
        providerId: typeof payload.provider_id === 'string' ? payload.provider_id : undefined,
        operator: payload.wagering_role === 'operator',
      };
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        // The Identity Provider could not be reached: not the caller's fault.
        throw new TransientInfrastructureError('Identity provider temporarily unavailable', {
          cause: error,
        });
      }
      throw new UnauthenticatedError('The bearer token is invalid or expired');
    }
  }
}
