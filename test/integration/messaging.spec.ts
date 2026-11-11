import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

// Own queues for this file, and fast retries so the tests do not wait.
const suffix = Date.now().toString(36);
process.env.SQS_TRANSACTIONS_QUEUE = `test-wager-transactions-${suffix}.fifo`;
process.env.SQS_DLQ = `test-wager-transactions-dlq-${suffix}.fifo`;
process.env.SQS_EVENTS_QUEUE = `test-wallet-events-${suffix}.fifo`;
process.env.CONSUMER_MAX_RECEIVES = '3';
process.env.CONSUMER_RETRY_BASE_SECONDS = '0';

import { TransientInfrastructureError } from '../../src/application/errors';
import { OutboxPublisher } from '../../src/application/outbox-publisher';
import { PendingReferenceRetrier } from '../../src/application/pending-reference-retrier';
import type { EventPublisher } from '../../src/application/ports';
import type { ProcessWagerTransactionUseCase } from '../../src/application/process-wager-transaction.use-case';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/database/mikro-orm.adapter';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues';
import { WagerTransactionsConsumer } from '../../src/infrastructure/sqs/wager-transactions.consumer';
import {
  balanceOf,
  command,
  countInconsistentWallets,
  createTestContext,
  ledgerMatchesBalance,
  ledgerOf,
  openWallet,
  unique,
  type TestContext,
} from './support/context';

let ctx: TestContext;
let queues: SqsQueues;
let sqsPublisher: SqsEventPublisher;
let outbox: OutboxPublisher;
let consumer: WagerTransactionsConsumer;
let retrier: PendingReferenceRetrier;

const POLL = { waitSeconds: 1 };

type Target = { walletId: string; playerId: string };

/** Body of a WagerTransactionRequested message, as a provider would send it. */
function requested(target: Target, kind: Kind, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? unique('ext');
  return {
    messageId: unique('msg'),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: target.playerId,
      walletId: target.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

async function send(body: unknown, groupId = 'group-1'): Promise<void> {
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: await queues.transactionsUrl(),
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: unique('dedup'), // each send is a separate delivery
    }),
  );
}

/** Receives and removes everything currently in a queue. */
async function drain(queueUrl: string) {
  const all: { body: string; reason?: string }[] = [];
  for (;;) {
    const { Messages = [] } = await queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    if (!Messages.length) return all;
    for (const m of Messages) {
      all.push({ body: m.Body ?? '', reason: m.MessageAttributes?.reason?.StringValue });
      await queues.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

const pendingOutbox = async () =>
  (await ctx.sql(`select count(*)::int as n from outbox_messages where published_at is null`))[0].n as number;

const inboxCount = async (messageId: string) =>
  (await ctx.sql(`select count(*)::int as n from inbox_messages where message_id = ?`, [messageId]))[0].n as number;

const debitsOf = async (walletId: string) =>
  (await ledgerOf(ctx, walletId)).filter((e) => e.direction === 'DEBIT').length;

/** Publishes for real and remembers how many times each event went out. */
function countingPublisher(): EventPublisher & { sent: Map<string, number> } {
  const sent = new Map<string, number>();
  return {
    sent,
    publish: async (message: OutboxMessage) => {
      await sqsPublisher.publish(message);
      sent.set(message.id, (sent.get(message.id) ?? 0) + 1);
    },
  };
}

const newOutboxPublisher = (publisher: EventPublisher = sqsPublisher) =>
  new OutboxPublisher(new MikroOrmOutboxRepository(ctx.orm), publisher, ctx.metrics);

beforeAll(async () => {
  ctx = await createTestContext();
  queues = new SqsQueues();
  sqsPublisher = new SqsEventPublisher(queues);
  outbox = newOutboxPublisher();
  consumer = new WagerTransactionsConsumer(queues, ctx.process, ctx.metrics);
  retrier = new PendingReferenceRetrier(ctx.queries, ctx.process);
  await queues.ping();
});

afterAll(async () => {
  expect(await countInconsistentWallets(ctx)).toBe(0);
  for (const url of [await queues.transactionsUrl(), await queues.deadLetterUrl(), await queues.eventsUrl()]) {
    await queues.client.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
  queues.onApplicationShutdown();
  await ctx.orm.close(true);
});

describe('transactional outbox', () => {
  it('publishes committed events once and marks them as published', async () => {
    const target = await openWallet(ctx, '100.00'); // 2 events
    await ctx.process.submit(command(target, Kind.Bet, '10.00')); // 2 events
    expect(await pendingOutbox()).toBe(4);

    expect(await outbox.publishBatch(100)).toEqual({ published: 4, failed: 0 });
    expect(await pendingOutbox()).toBe(0);
    expect(await outbox.publishBatch(100)).toEqual({ published: 0, failed: 0 });

    const events = (await drain(await queues.eventsUrl())).map((m) => JSON.parse(m.body));
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const balanceChanged = events.find((e) => e.eventType === 'WalletBalanceChanged' && e.data.direction === 'DEBIT');
    expect(balanceChanged).toMatchObject({
      version: 1,
      aggregateId: target.walletId,
      correlationId: 'test',
      data: {
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('two publishers working on the same outbox never publish the same event twice', async () => {
    const target = await openWallet(ctx, '1000.00');
    for (let i = 0; i < 20; i += 1) await ctx.process.submit(command(target, Kind.Bet, '1.00'));
    const total = await pendingOutbox();
    expect(total).toBe(42);

    const counter = countingPublisher();
    const a = newOutboxPublisher(counter);
    const b = newOutboxPublisher(counter);
    let published = 0;
    while ((await pendingOutbox()) > 0) {
      const results = await Promise.all([a.publishBatch(5), b.publishBatch(5)]);
      published += results[0].published + results[1].published;
    }
    expect(published).toBe(total);
    expect(counter.sent.size).toBe(total);
    expect([...counter.sent.values()].every((times) => times === 1)).toBe(true);
    expect(await drain(await queues.eventsUrl())).toHaveLength(total);
  });

  it('commit, crash before publishing, another instance takes over: nothing is lost', async () => {
    const target = await openWallet(ctx, '50.00');
    await ctx.process.submit(command(target, Kind.Bet, '5.00'));
    // The instance that committed dies here: its publisher fails on every event.
    const dying = newOutboxPublisher({ publish: () => Promise.reject(new Error('process killed')) });
    expect(await dying.publishBatch(100)).toEqual({ published: 0, failed: 4 });

    // Failed attempts are counted and scheduled for later, never dropped.
    const rows = await ctx.sql(
      `select attempts, next_attempt_at > now() as later from outbox_messages where published_at is null`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.attempts === 1 && r.later === true)).toBe(true);
    expect(await outbox.publishBatch(100)).toEqual({ published: 0, failed: 0 }); // not due yet

    await ctx.sql(`update outbox_messages set next_attempt_at = now() where published_at is null`);
    const survivor = newOutboxPublisher(); // a different instance
    expect(await survivor.publishBatch(100)).toEqual({ published: 4, failed: 0 });
    expect(await drain(await queues.eventsUrl())).toHaveLength(4);
  });

  it('a duplicated publication carries the same event id, so it is safe for consumers', async () => {
    const target = await openWallet(ctx, '0.00');
    await ctx.process.submit(command(target, Kind.Win, '1.00'));
    const counter = countingPublisher();
    await newOutboxPublisher(counter).publishBatch(100);
    // Simulates "published, then crashed before marking as published".
    await ctx.sql(`update outbox_messages set published_at = null where aggregate_id = ?`, [target.walletId]);
    await newOutboxPublisher(counter).publishBatch(100);

    expect([...counter.sent.values()].filter((times) => times === 2)).toHaveLength(1);
    const delivered = (await drain(await queues.eventsUrl())).map((m) => JSON.parse(m.body).eventId);
    expect(new Set(delivered).size).toBe(delivered.length); // the FIFO queue dropped the repeat
  });

  it('reports the outbox lag', async () => {
    const target = await openWallet(ctx, '10.00');
    await ctx.process.submit(command(target, Kind.Bet, '1.00'));
    const stats = await outbox.refreshLag();
    expect(stats.pending).toBe(4);
    expect(stats.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(ctx.metrics.render()).toContain('wager_outbox_pending 4');
    await outbox.publishBatch(100);
    await drain(await queues.eventsUrl());
    expect((await outbox.refreshLag()).pending).toBe(0);
  });
});

describe('SQS consumer', () => {
  it('processes a message through the same use case and acknowledges after the commit', async () => {
    const target = await openWallet(ctx, '100.00');
    const message = requested(target, Kind.Bet, '25.00');
    await send(message);

    expect(await consumer.pollOnce(POLL)).toBe(1);
    expect(await balanceOf(ctx, target.walletId)).toBe('75.00');
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await consumer.pollOnce(POLL)).toBe(0); // acknowledged: the queue is empty
  });

  it('a redelivered message has no second effect (inbox)', async () => {
    const target = await openWallet(ctx, '100.00');
    const message = requested(target, Kind.Bet, '25.00');
    await send(message);
    await send(message); // same messageId delivered again
    const before = ctx.metrics.counter('wager_duplicates_total', { source: 'sqs' });

    expect(await consumer.pollOnce(POLL)).toBe(2);
    expect(await balanceOf(ctx, target.walletId)).toBe('75.00');
    expect(await debitsOf(target.walletId)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(ctx.metrics.counter('wager_duplicates_total', { source: 'sqs' })).toBe(before + 1);
  });

  it('worker dies after the commit and before the ack: the redelivery does not debit again', async () => {
    const target = await openWallet(ctx, '100.00');
    const message = requested(target, Kind.Bet, '40.00');
    await send(message);

    // Same real queue, but this worker fails exactly when it tries to acknowledge.
    const dyingQueues = Object.create(queues) as SqsQueues;
    Object.defineProperty(dyingQueues, 'client', {
      value: {
        send: (cmd: unknown, ...rest: unknown[]) =>
          cmd instanceof DeleteMessageCommand
            ? Promise.reject(new Error('worker killed before ack'))
            : (queues.client.send as (...args: unknown[]) => Promise<unknown>)(cmd, ...rest),
      },
    });
    const dying = new WagerTransactionsConsumer(dyingQueues, ctx.process, ctx.metrics);
    await dying.pollOnce(POLL);
    expect(await balanceOf(ctx, target.walletId)).toBe('60.00'); // committed

    expect(await consumer.pollOnce(POLL)).toBe(1); // the message comes back
    expect(await balanceOf(ctx, target.walletId)).toBe('60.00');
    expect(await debitsOf(target.walletId)).toBe(1);
    expect(await consumer.pollOnce(POLL)).toBe(0);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('acknowledges a business rejection: it is a final answer, not a failure', async () => {
    const target = await openWallet(ctx, '5.00');
    const message = requested(target, Kind.Bet, '50.00');
    await send(message);
    await consumer.pollOnce(POLL);

    const [tx] = await ctx.sql(`select status, failure_code from wager_transactions where idempotency_key = ?`, [
      message.data.idempotencyKey,
    ]);
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await consumer.pollOnce(POLL)).toBe(0);
    expect(await drain(await queues.deadLetterUrl())).toHaveLength(0);
  });

  it('moves messages that can never work straight to the DLQ', async () => {
    const target = await openWallet(ctx, '100.00');
    const used = requested(target, Kind.Bet, '1.00');
    await send(used);
    await consumer.pollOnce(POLL);

    await send('this is not json');
    await send({ messageId: unique('msg'), type: 'SomethingElse', data: {} });
    await send(requested(target, Kind.Bet, '1.999'));
    await send(requested(target, Kind.Opening, '1.00'));
    // Same idempotency key, different amount: a conflict, never a replay.
    await send({ ...used, messageId: unique('msg'), data: { ...used.data, money: { amount: '2.00', currency: 'BRL' } } });
    await consumer.pollOnce(POLL);

    const dead = await drain(await queues.deadLetterUrl());
    expect(dead.map((m) => m.reason).sort()).toEqual([
      'IDEMPOTENCY_CONFLICT',
      'INVALID_MONEY',
      'VALIDATION_ERROR',
      'VALIDATION_ERROR',
      'VALIDATION_ERROR',
    ]);
    expect(await consumer.pollOnce(POLL)).toBe(0);
    expect(await balanceOf(ctx, target.walletId)).toBe('99.00');
  });

  it('retries a transient failure and succeeds once the problem is gone', async () => {
    const target = await openWallet(ctx, '100.00');
    await send(requested(target, Kind.Bet, '10.00'));
    let failures = 2;
    const flakyUseCase = {
      submit: (...args: Parameters<ProcessWagerTransactionUseCase['submit']>) =>
        failures-- > 0
          ? Promise.reject(new TransientInfrastructureError('database temporarily unavailable'))
          : ctx.process.submit(...args),
    } as ProcessWagerTransactionUseCase;
    const flaky = new WagerTransactionsConsumer(queues, flakyUseCase, ctx.metrics);
    const retriesBefore = ctx.metrics.counter('wager_retries_total', { component: 'consumer' });

    await flaky.pollOnce(POLL); // fails, stays in the queue
    await flaky.pollOnce(POLL); // fails again
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    await flaky.pollOnce(POLL); // works
    expect(await balanceOf(ctx, target.walletId)).toBe('90.00');
    expect(ctx.metrics.counter('wager_retries_total', { component: 'consumer' })).toBe(retriesBefore + 2);
    expect(await drain(await queues.deadLetterUrl())).toHaveLength(0);
  });

  it('gives up after the delivery limit and moves the message to the DLQ', async () => {
    const target = await openWallet(ctx, '100.00');
    await send(requested(target, Kind.Bet, '10.00'));
    const broken = new WagerTransactionsConsumer(
      queues,
      { submit: () => Promise.reject(new Error('unexpected bug')) } as unknown as ProcessWagerTransactionUseCase,
      ctx.metrics,
    );
    for (let i = 0; i < 3; i += 1) await broken.pollOnce(POLL); // CONSUMER_MAX_RECEIVES = 3

    const dead = await drain(await queues.deadLetterUrl());
    expect(dead.map((m) => m.reason)).toEqual(['MAX_RECEIVES_EXCEEDED']);
    expect(await consumer.pollOnce(POLL)).toBe(0);
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    expect(ctx.metrics.counter('wager_dlq_messages_total', { reason: 'MAX_RECEIVES_EXCEEDED' })).toBe(1);
  });

  it('on shutdown, hands unstarted messages back to the queue untouched', async () => {
    const target = await openWallet(ctx, '100.00');
    await send(requested(target, Kind.Bet, '10.00'));

    expect(await consumer.pollOnce({ ...POLL, shouldStop: () => true })).toBe(1);
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00'); // not processed by the stopping worker

    expect(await consumer.pollOnce(POLL)).toBe(1); // another instance gets it at once
    expect(await balanceOf(ctx, target.walletId)).toBe('90.00');
  });

  it('the same transaction arriving by HTTP and by the queue is applied once', async () => {
    const target = await openWallet(ctx, '100.00');
    const message = requested(target, Kind.Bet, '30.00');
    await ctx.process.submit({
      ...message.data,
      kind: Kind.Bet,
      correlationId: 'http',
    });
    await send(message);
    await consumer.pollOnce(POLL);
    expect(await balanceOf(ctx, target.walletId)).toBe('70.00');
    expect(await debitsOf(target.walletId)).toBe(1);
  });
});

describe('references out of order, through the queue', () => {
  it('a ROLLBACK delivered before its BET waits, then the retry worker resolves it', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = requested(target, Kind.Bet, '40.00');
    const rollback = requested(target, Kind.Rollback, '40.00', {
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await send(rollback);
    await consumer.pollOnce(POLL);
    const status = async () =>
      (await ctx.sql(`select status from wager_transactions where idempotency_key = ?`, [rollback.data.idempotencyKey]))[0]
        .status;
    expect(await status()).toBe(Status.PendingReference);

    expect(await retrier.runOnce(20, new Date())).toBe(0); // not due yet: no busy retrying

    await send(bet);
    await consumer.pollOnce(POLL);
    expect(await balanceOf(ctx, target.walletId)).toBe('60.00');

    const afterBackoff = new Date(Date.now() + 60_000);
    expect(await retrier.runOnce(20, afterBackoff)).toBeGreaterThanOrEqual(1);
    expect(await status()).toBe(Status.Processed);
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });
});
