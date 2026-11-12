import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { HttpErrorFilter } from '../../src/http/http-error.filter';
import { unique } from './support/context';
import { createTestOrm, TEST_DATABASE_URL } from './support/database';

/**
 * The real guard and the real signature verification, against a stand-in
 * Identity Provider: an HTTP server that publishes a public key (JWKS), exactly
 * as Keycloak does. Tokens are signed here with the matching private key.
 */
const ISSUER = 'http://idp.test/realms/wagering';
const AUDIENCE = 'wagering-api';
const ENV = [
  'AUTH_ENABLED',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AUTH_JWKS_URL',
  'CONSUMER_ENABLED',
  'OUTBOX_PUBLISHER_ENABLED',
  'PENDING_REFERENCE_WORKER_ENABLED',
];

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let idpKeys: Keys;
let strangerKeys: Keys;
let jwksServer: ReturnType<typeof Bun.serve>;
let app: INestApplication;
const http = () => request(app.getHttpServer());

interface TokenOptions {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  keys?: Keys;
}

function token(claims: Record<string, unknown>, options: TokenOptions = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('service-account')
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign((options.keys ?? idpKeys).privateKey);
}

const providerToken = (providerId: string, options?: TokenOptions) =>
  token({ provider_id: providerId, wagering_role: 'provider' }, options);
const operatorToken = () => token({ wagering_role: 'operator' });
const bearer = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

async function createWallet(amount = '100.00') {
  const playerId = unique('player');
  const res = await http()
    .post('/wallets')
    .set(bearer(await operatorToken()))
    .send({ playerId, initialBalance: { amount, currency: 'BRL' } });
  return { walletId: res.body.id as string, playerId };
}

function bet(target: { walletId: string; playerId: string }, providerId: string) {
  return {
    providerId,
    externalTransactionId: unique('ext'),
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
}

const submit = (payload: ReturnType<typeof bet>, jwt?: string) => {
  const req = http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', `${payload.providerId}:${payload.externalTransactionId}`);
  return (jwt ? req.set(bearer(jwt)) : req).send(payload);
};

beforeAll(async () => {
  idpKeys = await generateKeyPair('RS256');
  strangerKeys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(idpKeys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });

  await (await createTestOrm()).close(true);
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL = 'silent';
  process.env.AUTH_ENABLED = 'true';
  process.env.AUTH_ISSUER = ISSUER;
  process.env.AUTH_AUDIENCE = AUDIENCE;
  process.env.AUTH_JWKS_URL = `http://localhost:${jwksServer.port}/certs`;
  process.env.CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await jwksServer?.stop(true);
  for (const name of ENV) delete process.env[name];
});

describe('authentication', () => {
  it('401 without a token or with something that is not a bearer token', async () => {
    const target = await createWallet();
    const missing = await submit(bet(target, 'provider-a'));
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    expect((await http().get(`/wallets/${target.walletId}`).set('Authorization', 'Basic abc')).status).toBe(401);
    expect((await submit(bet(target, 'provider-a'), 'not-a-jwt')).status).toBe(401);
  });

  it('401 for expired tokens and for the wrong issuer or audience', async () => {
    const target = await createWallet();
    const expired = await providerToken('provider-a', { expiresIn: '-1m' });
    const wrongIssuer = await providerToken('provider-a', { issuer: 'http://evil.test/realms/wagering' });
    const wrongAudience = await providerToken('provider-a', { audience: 'another-api' });
    for (const jwt of [expired, wrongIssuer, wrongAudience]) {
      expect((await submit(bet(target, 'provider-a'), jwt)).status).toBe(401);
    }
  });

  it('401 for a well-formed token signed by a key the identity provider does not publish', async () => {
    const target = await createWallet();
    const forged = await providerToken('provider-a', { keys: strangerKeys });
    expect((await submit(bet(target, 'provider-a'), forged)).status).toBe(401);
  });

  it('401 for an unsigned token ("alg": "none")', async () => {
    const target = await createWallet();
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'x',
      provider_id: 'provider-a',
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;
    expect((await submit(bet(target, 'provider-a'), unsigned)).status).toBe(401);
  });

  it('health checks and metrics stay open', async () => {
    expect((await http().get('/health/live')).status).toBe(200);
    expect((await http().get('/health/ready')).status).toBe(200);
    expect((await http().get('/metrics')).status).toBe(200);
  });
});

describe('authorization', () => {
  it('a provider submits and reads its own transactions', async () => {
    const target = await createWallet();
    const jwt = await providerToken('provider-a');
    const payload = bet(target, 'provider-a');
    const res = await submit(payload, jwt);
    expect(res.status).toBe(200);
    expect(res.body.balance.amount).toBe('90.00');

    const byId = await http().get(`/wagering/transactions/${res.body.transactionId}`).set(bearer(jwt));
    expect(byId.status).toBe(200);
    const byExternal = await http()
      .get(`/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`)
      .set(bearer(jwt));
    expect(byExternal.status).toBe(200);
    expect((await http().get(`/wallets/${target.walletId}`).set(bearer(jwt))).status).toBe(200);
  });

  it('403 when a provider sends a transaction in the name of another provider', async () => {
    const target = await createWallet();
    const res = await submit(bet(target, 'provider-b'), await providerToken('provider-a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // Nothing was processed.
    const wallet = await http().get(`/wallets/${target.walletId}`).set(bearer(await operatorToken()));
    expect(wallet.body.balance.amount).toBe('100.00');
  });

  it('a provider cannot read the transactions of another provider', async () => {
    const target = await createWallet();
    const payload = bet(target, 'provider-b');
    const { body } = await submit(payload, await providerToken('provider-b'));
    const outsider = bearer(await providerToken('provider-a'));

    expect((await http().get(`/wagering/transactions/${body.transactionId}`).set(outsider)).status).toBe(404);
    expect(
      (await http().get(`/providers/provider-b/wagering/transactions/${payload.externalTransactionId}`).set(outsider))
        .status,
    ).toBe(403);
  });

  it('403 when a provider tries operator-only operations', async () => {
    const target = await createWallet();
    const jwt = bearer(await providerToken('provider-a'));
    const create = await http()
      .post('/wallets')
      .set(jwt)
      .send({ playerId: unique('player'), initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(create.status).toBe(403);
    expect((await http().post(`/wallets/${target.walletId}/reconciliation`).set(jwt)).status).toBe(403);
  });

  it('an operator manages wallets and may act for any provider', async () => {
    const target = await createWallet();
    const jwt = await operatorToken();
    expect((await http().post(`/wallets/${target.walletId}/reconciliation`).set(bearer(jwt))).status).toBe(200);
    expect((await submit(bet(target, 'provider-a'), jwt)).status).toBe(200);
  });

  it('403 for a valid token that carries no provider and no role', async () => {
    const target = await createWallet();
    expect((await submit(bet(target, 'provider-a'), await token({}))).status).toBe(403);
  });
});

describe('identity provider unavailable', () => {
  it('503 (retry later), not 401, when the keys cannot be fetched', async () => {
    const previous = process.env.AUTH_JWKS_URL;
    process.env.AUTH_JWKS_URL = 'http://localhost:9/certs'; // nothing listens there
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const offline = moduleRef.createNestApplication();
    offline.useGlobalFilters(new HttpErrorFilter());
    await offline.init();
    try {
      const res = await request(offline.getHttpServer())
        .get('/wallets/00000000-0000-7000-8000-000000000000')
        .set(bearer(await operatorToken()));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('TRANSIENT_FAILURE');
    } finally {
      await offline.close();
      process.env.AUTH_JWKS_URL = previous;
    }
  });
});
