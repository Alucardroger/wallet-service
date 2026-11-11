import type { FailureCode } from './failure-code';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { MoneyProps } from './money';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** What the caller knows when an event is raised. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Serialized envelope stored in the outbox payload. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: { ...this.data } as T,
    };
  }
}

interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

const summarize = (tx: WagerTransaction): TransactionSummary => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

const base = (tx: WagerTransaction, ctx: EventContext) => ({
  eventId: ctx.eventId,
  aggregateId: tx.id,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.occurredAt,
});

export interface WagerTransactionProcessedData extends TransactionSummary {
  balance: MoneyProps | null;
  referenceTransactionId: string | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx, ctx),
      data: {
        ...summarize(tx),
        balance: tx.resultBalance?.toJSON() ?? null,
        referenceTransactionId: tx.referenceTransactionId ?? null,
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: FailureCode;
  balance: MoneyProps | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(tx, ctx),
      data: {
        ...summarize(tx),
        failureCode: tx.failureCode as FailureCode,
        balance: tx.resultBalance?.toJSON() ?? null,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx, ctx),
      data: {
        ...summarize(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId as string,
        attempts: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
