import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { HttpErrorFilter } from '../../src/http/http-error.filter';
import { createTestOrm, TEST_DATABASE_URL } from './support/database';
import { unique } from './support/context';

let app: INestApplication;
const http = () => request(app.getHttpServer());

async function createWallet(amount = '100.00') {
  const playerId = unique('player');
  const res = await http().post('/wallets').send({ playerId, initialBalance: { amount, currency: 'BRL' } });
  return { walletId: res.body.id as string, playerId, res };
}

function body(target: { walletId: string; playerId: string }, kind: string, amount: string, extra: object = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: unique('ext'),
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (payload: Record<string, unknown>, key?: string) =>
  http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', key ?? `${String(payload.providerId)}:${String(payload.externalTransactionId)}`)
    .send(payload);

beforeAll(async () => {
  // Fresh schema in the test database, then the real application on top of it.
  await (await createTestOrm()).close(true);
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('POST /wallets', () => {
  it('201 with the wallet; 409 for the same player and currency', async () => {
    const { res, playerId } = await createWallet('1000.00');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const again = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('400 for invalid money (number, 3 decimals, negative, scientific notation)', async () => {
    for (const amount of [25, '25.000', '-1.00', '1e3', '']) {
      const res = await http()
        .post('/wallets')
        .send({ playerId: unique('player'), initialBalance: { amount, currency: 'BRL' } });
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /wagering/transactions', () => {
  it('200 PROCESSED, then the same answer flagged as replay', async () => {
    const target = await createWallet('1000.00');
    const payload = body(target, 'BET', '25.00');
    const first = await submit(payload);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(first.headers['x-correlation-id']).toBeTruthy();

    const replay = await submit(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('409 when the key is reused with a different payload', async () => {
    const target = await createWallet();
    const payload = body(target, 'BET', '10.00');
    await submit(payload);
    const conflict = await submit({ ...payload, money: { amount: '11.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('422 with a failureCode for a business rejection, also on replay', async () => {
    const target = await createWallet('10.00');
    const payload = body(target, 'BET', '50.00');
    const rejected = await submit(payload);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect((await submit(payload)).status).toBe(422);
  });

  it('202 while a reversal waits for its reference', async () => {
    const target = await createWallet();
    const res = await submit(body(target, 'ROLLBACK', '5.00', { referenceExternalTransactionId: unique('later') }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  it('400 for a missing key, an invalid payload or the internal OPENING kind', async () => {
    const target = await createWallet();
    const noKey = await http().post('/wagering/transactions').send(body(target, 'BET', '1.00'));
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('VALIDATION_ERROR');

    const invalid = [
      body(target, 'OPENING', '1.00'),
      body(target, 'BET', '1.5'),
      body(target, 'BET', '0.00'),
      body(target, 'REFUND', '1.00'),
      body(target, 'BET', '1.00', { walletId: 'not-a-uuid' }),
      body(target, 'BET', '1.00', { money: { amount: 1, currency: 'BRL' } }),
      { ...body(target, 'BET', '1.00'), providerId: undefined },
    ];
    for (const payload of invalid) {
      const res = await submit(payload, unique('key'));
      expect(res.status).toBe(400);
    }
  });
});

describe('queries', () => {
  it('reads the wallet, the transaction by both ids, and 404 for unknown ones', async () => {
    const target = await createWallet('100.00');
    const payload = body(target, 'BET', '40.00');
    const { body: result } = await submit(payload);

    const wallet = await http().get(`/wallets/${target.walletId}`);
    expect(wallet.body).toMatchObject({ balance: { amount: '60.00', currency: 'BRL' }, version: 2 });

    const byId = await http().get(`/wagering/transactions/${result.transactionId}`);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', balance: { amount: '60.00' } });
    const byExternal = await http().get(
      `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(byExternal.body.transactionId).toBe(result.transactionId);

    const missing = '00000000-0000-7000-8000-000000000000';
    expect((await http().get(`/wallets/${missing}`)).status).toBe(404);
    expect((await http().get(`/wagering/transactions/${missing}`)).status).toBe(404);
    expect((await http().get(`/wallets/not-a-uuid`)).status).toBe(400);
  });

  it('pages the ledger with a stable, opaque cursor', async () => {
    const target = await createWallet('100.00');
    for (let i = 0; i < 4; i += 1) await submit(body(target, 'BET', '1.00'));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/wallets/${target.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await http().get(url);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((e: { balanceAfter: { amount: string } }) => e.balanceAfter.amount));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00']);
    expect((await http().get(`/wallets/${target.walletId}/ledger?cursor=garbage`)).status).toBe(400);
  });
});
