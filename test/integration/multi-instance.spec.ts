import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import {
  balanceOf,
  countInconsistentWallets,
  createTestContext,
  ledgerMatchesBalance,
  ledgerOf,
  unique,
  type TestContext,
} from './support/context';
import { TEST_DATABASE_URL } from './support/database';

/**
 * Starts the real application three times, as separate operating-system
 * processes sharing one PostgreSQL and one SQS, and attacks them together.
 */
const suffix = Date.now().toString(36);
const QUEUES = {
  SQS_TRANSACTIONS_QUEUE: `mi-wager-transactions-${suffix}.fifo`,
  SQS_DLQ: `mi-wager-transactions-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE: `mi-wallet-events-${suffix}.fifo`,
};
const BASE_PORT = 3400 + Math.floor(Math.random() * 400);
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

let ctx: TestContext;
const instances = new Map<number, Subprocess>();
const url = (index: number, path: string) => `http://localhost:${BASE_PORT + index}${path}`;

async function startInstance(index: number): Promise<void> {
  const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      ...QUEUES,
      PORT: String(BASE_PORT + index),
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'error',
      CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_VISIBILITY_SECONDS: '3',
      OUTBOX_POLL_MS: '100',
      PENDING_REFERENCE_POLL_MS: '200',
      REFERENCE_RETRY_BASE_MS: '100',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  instances.set(index, child);
  await until(async () => (await fetch(url(index, '/health/ready')).catch(() => null))?.status === 200, 20_000);
}

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(100);
  }
}

async function post(index: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url(index, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createWallet(amount: string) {
  const playerId = unique('player');
  const { body } = await post(0, '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  return { walletId: body.id as string, playerId };
}

function payload(target: { walletId: string; playerId: string }, kind: string, amount: string, extra: object = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: unique('ext'),
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (index: number, p: ReturnType<typeof payload>) =>
  post(index, '/wagering/transactions', p, { 'Idempotency-Key': `${p.providerId}:${p.externalTransactionId}` });

async function queueUrl(name: string): Promise<string> {
  return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl as string;
}

async function enqueue(p: ReturnType<typeof payload>, messageId = unique('msg')): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(QUEUES.SQS_TRANSACTIONS_QUEUE),
      MessageGroupId: p.walletId,
      MessageDeduplicationId: unique('dedup'),
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...p, idempotencyKey: `${p.providerId}:${p.externalTransactionId}` },
      }),
    }),
  );
}

const count = async (query: string, params: unknown[] = []) => (await ctx.sql(query, params))[0].n as number;
const debitsOf = async (walletId: string) => (await ledgerOf(ctx, walletId)).filter((e) => e.direction === 'DEBIT').length;

beforeAll(async () => {
  ctx = await createTestContext(); // fresh schema, shared by the three processes
  await Promise.all([0, 1, 2].map(startInstance));
}, 60_000);

afterAll(async () => {
  for (const child of instances.values()) child.kill('SIGKILL');
  sqs.destroy();
  await ctx.orm.close(true);
});

describe('three instances at the same time', () => {
  it('mandatory scenario with each bet sent to a different instance', async () => {
    const target = await createWallet('100.00');
    const results = await Promise.all([submit(1, payload(target, 'BET', '80.00')), submit(2, payload(target, 'BET', '80.00'))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(ctx, target.walletId)).toBe('20.00');
    expect(await debitsOf(target.walletId)).toBe(1);
  });

  it('the same bet sent 60 times across the instances debits once', async () => {
    const target = await createWallet('100.00');
    const bet = payload(target, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => submit(i % 3, bet)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await balanceOf(ctx, target.walletId)).toBe('90.00');
    expect(await debitsOf(target.walletId)).toBe(1);
  });

  it('a hot wallet hit through all instances never goes negative', async () => {
    const target = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 45 }, (_, i) => submit(i % 3, payload(target, 'BET', '10.00'))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(35);
    expect(await balanceOf(ctx, target.walletId)).toBe('0.00');
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('several wallets are processed in parallel by the three instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet('50.00')));
    await Promise.all(
      wallets.flatMap((target, w) => Array.from({ length: 5 }, (_, i) => submit((w + i) % 3, payload(target, 'BET', '10.00')))),
    );
    for (const target of wallets) expect(await balanceOf(ctx, target.walletId)).toBe('0.00');
  });

  it('queue messages, duplicated and consumed by competing workers, are applied once each', async () => {
    const target = await createWallet('1000.00');
    const bets = Array.from({ length: 20 }, () => payload(target, 'BET', '10.00'));
    for (const bet of bets) {
      const messageId = unique('msg');
      await enqueue(bet, messageId);
      await enqueue(bet, messageId); // every message delivered twice
    }
    await until(async () => (await balanceOf(ctx, target.walletId)) === '800.00', 30_000);
    await Bun.sleep(1_500); // give duplicates the chance to do damage
    expect(await balanceOf(ctx, target.walletId)).toBe('800.00');
    expect(await debitsOf(target.walletId)).toBe(20);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  }, 60_000);

  it('a reversal delivered before its reference is resolved by the retry workers', async () => {
    const target = await createWallet('100.00');
    const bet = payload(target, 'BET', '40.00');
    const early = await submit(0, payload(target, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(early.status).toBe(202);
    await submit(1, bet);
    await until(
      async () =>
        (await count(`select count(*)::int as n from wager_transactions where id = ? and status = 'PROCESSED'`, [
          early.body.transactionId,
        ])) === 1,
      20_000,
    );
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  }, 30_000);
});

describe('crash and restart', () => {
  it('an instance killed under load loses nothing: the others and its replacement finish the work', async () => {
    const target = await createWallet('1000.00');
    const bets = Array.from({ length: 30 }, () => payload(target, 'BET', '10.00'));
    for (const bet of bets) await enqueue(bet);

    await until(async () => (await debitsOf(target.walletId)) >= 3, 20_000);
    instances.get(2)?.kill('SIGKILL'); // dies with messages in flight and events unpublished
    await startInstance(3); // its replacement

    await until(async () => (await balanceOf(ctx, target.walletId)) === '700.00', 40_000);
    await Bun.sleep(1_500);
    expect(await balanceOf(ctx, target.walletId)).toBe('700.00');
    expect(await debitsOf(target.walletId)).toBe(30);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  }, 90_000);

  it('every committed event ends up published, each one once', async () => {
    await until(async () => (await count(`select count(*)::int as n from outbox_messages where published_at is null`)) === 0, 30_000);
    const total = await count(`select count(*)::int as n from outbox_messages`);

    const eventsUrl = await queueUrl(QUEUES.SQS_EVENTS_QUEUE);
    const seen: string[] = [];
    for (let empty = 0; empty < 2; ) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      empty = Messages.length ? 0 : empty + 1;
      for (const m of Messages) {
        seen.push(JSON.parse(m.Body ?? '{}').eventId);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    }
    expect(new Set(seen).size).toBe(total);
    expect(seen.length).toBe(total);
  }, 90_000);

  it('SIGTERM stops an instance cleanly', async () => {
    const child = instances.get(0) as Subprocess;
    child.kill('SIGTERM');
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout')]);
    // After its shutdown hooks finish, NestJS ends the process with the same
    // signal, which the shell reports as 128 + 15. A hang would be 'timeout'.
    expect([0, 143]).toContain(code as number);
    instances.delete(0);
  }, 20_000);

  it('after all of it, no wallet disagrees with its ledger', async () => {
    expect(await countInconsistentWallets(ctx)).toBe(0);
  });
});
