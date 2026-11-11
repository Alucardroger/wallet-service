import { Injectable } from '@nestjs/common';
import {
  LockMode,
  MikroORM,
  UniqueConstraintViolationException,
  type EntityManager,
} from '@mikro-orm/postgresql';
import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import {
  OutboxRepository,
  UnitOfWork,
  WalletQueries,
  type LedgerPageItem,
  type RelayResult,
  type WagerStore,
} from '../../application/ports';
import type { FailureCode } from '../../domain/failure-code';
import type { InboxMessage } from '../../domain/inbox-message';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { JsonLogger, describeError } from '../../shared/logger';
import { Metrics } from '../../shared/metrics';
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/** How long a statement waits for a row lock before giving up (transient error). */
export const LOCK_TIMEOUT_MS = Number(process.env.DB_LOCK_TIMEOUT_MS ?? 5_000);

// ----------------------------------------------------------------- mappers

const toWallet = (r: WalletRecord): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balance, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

const toTransaction = (r: WagerTransactionRecord): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: r.processedAt ?? undefined,
    resultBalance: r.resultBalance
      ? Money.from({ amount: r.resultBalance, currency: r.currency })
      : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
  });

/** The part of a transaction that changes after it is created. */
const mutableTransactionFields = (tx: WagerTransaction) => ({
  status: tx.status,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  failureCode: tx.failureCode ?? null,
  resultBalance: tx.resultBalance?.toJSON().amount ?? null,
  referenceAttempts: tx.referenceAttempts,
  nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
  processedAt: tx.processedAt ?? null,
});

// -------------------------------------------------------------- write side

class MikroOrmWagerStore implements WagerStore {
  /** Records loaded in this transaction, kept to apply later updates to them. */
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly transactions = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | null> {
    // SELECT ... FOR UPDATE: other transactions touching this wallet wait here.
    const record = await this.em.findOne(WalletRecord, walletId, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    if (!record) return null;
    this.wallets.set(record.id, record);
    return toWallet(record);
  }

  findTransactionById(id: string): Promise<WagerTransaction | null> {
    return this.findTransaction({ id });
  }

  findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.findTransaction({ idempotencyKey: key });
  }

  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    return this.findTransaction({ providerId, externalTransactionId: externalId });
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind,
      status: 'PROCESSED',
    });
    return count > 0;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    const record = this.em.create(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    this.wallets.set(record.id, record);
    await this.em.persist(record).flush();
  }

  async updateWallet(wallet: Wallet): Promise<void> {
    const record = this.wallets.get(wallet.id);
    if (!record) throw new Error(`Wallet ${wallet.id} was not locked in this transaction`);
    record.balance = wallet.balance.toJSON().amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
    await this.em.flush();
  }

  async insertTransaction(tx: WagerTransaction, correlationId: string): Promise<void> {
    const money = tx.money.toJSON();
    const record = this.em.create(WagerTransactionRecord, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: money.amount,
      currency: money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      correlationId,
      createdAt: tx.createdAt,
      ...mutableTransactionFields(tx),
    });
    this.transactions.set(record.id, record);
    await this.em.persist(record).flush();
  }

  async updateTransaction(tx: WagerTransaction): Promise<void> {
    const record = this.transactions.get(tx.id);
    if (!record) throw new Error(`Transaction ${tx.id} was not loaded in this transaction`);
    Object.assign(record, mutableTransactionFields(tx));
    await this.em.flush();
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const record = this.em.create(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
    await this.em.persist(record).flush();
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    const record = this.em.create(OutboxRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
    await this.em.persist(record).flush();
  }

  async saveInbox(message: InboxMessage): Promise<boolean> {
    const key = { consumerName: message.consumerName, messageId: message.messageId };
    if (await this.em.findOne(InboxRecord, key)) return false;
    const record = this.em.create(InboxRecord, {
      ...key,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
    await this.em.persist(record).flush();
    return true;
  }

  private async findTransaction(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | null> {
    // refresh: always read the committed row, not a copy cached earlier in this transaction.
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    if (!record) return null;
    this.transactions.set(record.id, record);
    return toTransaction(record);
  }
}

const TRANSIENT_SQLSTATES = new Set(['55P03', '40P01', '40001', '57014', '57P01', '57P03', '53300']);
const TRANSIENT_SYSTEM_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/** Converts driver errors into errors the application layer understands. */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as { constraint?: string }).constraint ?? 'unknown';
    return new UniqueViolationError(constraint);
  }
  const code = String((error as { code?: unknown })?.code ?? '');
  if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SYSTEM_CODES.has(code) || code.startsWith('08')) {
    return new TransientInfrastructureError(`Database temporarily unavailable (${code})`, {
      cause: error,
    });
  }
  return error;
}

const LOCK_SQLSTATES: Record<string, string> = { '55P03': 'lock_timeout', '40P01': 'deadlock', '40001': 'serialization' };

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {
    super();
  }

  async run<T>(work: (store: WagerStore) => Promise<T>): Promise<T> {
    // A fresh EntityManager (own identity map) per unit of work.
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tem) => {
        await tem.execute(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        return work(new MikroOrmWagerStore(tem));
      });
    } catch (error) {
      const lockKind = LOCK_SQLSTATES[String((error as { code?: unknown })?.code ?? '')];
      if (lockKind) this.metrics.increment('wager_lock_conflicts_total', { kind: lockKind });
      throw translateDatabaseError(error);
    }
  }
}

// ------------------------------------------------------------------ outbox

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  private readonly logger = new JsonLogger(MikroOrmOutboxRepository.name);

  constructor(private readonly orm: MikroORM) {
    super();
  }

  async relay(limit: number, publish: (message: OutboxMessage) => Promise<void>): Promise<RelayResult> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tem) => {
        // SKIP LOCKED: several publishers can run at once and each takes
        // different rows, without waiting for one another.
        const due = await tem.execute<{ id: string }[]>(
          `select id from outbox_messages
            where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
            order by seq
            limit ?
            for update skip locked`,
          [limit],
        );
        const result: RelayResult = { published: 0, failed: 0 };
        for (const { id } of due) {
          const record = await tem.findOneOrFail(OutboxRecord, id);
          const message = OutboxMessage.rehydrate({
            id: record.id,
            aggregateId: record.aggregateId,
            eventType: record.eventType,
            payload: record.payload,
            occurredAt: record.occurredAt,
            attempts: record.attempts,
            nextAttemptAt: record.nextAttemptAt ?? undefined,
            publishedAt: record.publishedAt ?? undefined,
          });
          const now = new Date();
          try {
            await publish(message);
            message.markPublished(now);
            result.published += 1;
          } catch (error) {
            message.scheduleRetry(now);
            result.failed += 1;
            this.logger.warn('outbox publish failed, will retry', {
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
              ...describeError(error),
            });
          }
          record.attempts = message.attempts;
          record.nextAttemptAt = message.nextAttemptAt ?? null;
          record.publishedAt = message.publishedAt ?? null;
        }
        return result;
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async stats(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    try {
      const [row] = await this.orm.em.fork().execute<{ pending: number; age: number }[]>(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as age
           from outbox_messages where published_at is null`,
      );
      return { pending: row.pending, oldestAgeSeconds: Math.max(0, Number(row.age)) };
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

// --------------------------------------------------------------- read side

@Injectable()
export class MikroOrmWalletQueries extends WalletQueries {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async findWallet(walletId: string): Promise<Wallet | null> {
    const record = await this.read((em) => em.findOne(WalletRecord, walletId));
    return record ? toWallet(record) : null;
  }

  async findTransaction(id: string): Promise<WagerTransaction | null> {
    const record = await this.read((em) => em.findOne(WagerTransactionRecord, id));
    return record ? toTransaction(record) : null;
  }

  async findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    const record = await this.read((em) =>
      em.findOne(WagerTransactionRecord, { providerId, externalTransactionId: externalId }),
    );
    return record ? toTransaction(record) : null;
  }

  async ledgerPage(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.read((em) =>
      em.execute<LedgerRow[]>(
        `select seq::text as seq, id, wallet_id, transaction_id, direction, currency, created_at,
                amount::text as amount, balance_before::text as balance_before, balance_after::text as balance_after
           from wallet_ledger_entries
          where wallet_id = ? and seq > ?
          order by seq
          limit ?`,
        [walletId, afterSeq ?? '0', limit],
      ),
    );
    return rows.map((row) => {
      const m = (amount: string) => Money.from({ amount, currency: row.currency });
      return {
        seq: row.seq,
        entry: WalletLedgerEntry.rehydrate({
          id: row.id,
          walletId: row.wallet_id,
          transactionId: row.transaction_id,
          direction: row.direction as LedgerDirection,
          money: m(row.amount),
          balanceBefore: m(row.balance_before),
          balanceAfter: m(row.balance_after),
          createdAt: new Date(row.created_at),
        }),
      };
    });
  }

  async ledgerTotals(walletId: string): Promise<{ credits: string; debits: string; entries: number }> {
    const [row] = await this.read((em) =>
      em.execute<{ credits: string; debits: string; entries: number }[]>(
        `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
                coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(20,2)::text as debits,
                count(*)::int as entries
           from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
      ),
    );
    return row;
  }

  async duePendingReferences(now: Date, limit: number): Promise<string[]> {
    const rows = await this.read((em) =>
      em.execute<{ id: string }[]>(
        `select id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
          order by next_reference_attempt_at
          limit ?`,
        [now, limit],
      ),
    );
    return rows.map((row) => row.id);
  }

  async ping(): Promise<void> {
    await this.read((em) => em.execute('select 1'));
  }

  private async read<T>(query: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await query(this.orm.em.fork());
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  currency: string;
  created_at: string | Date;
  amount: string;
  balance_before: string;
  balance_after: string;
}
