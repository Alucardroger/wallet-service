import { Injectable } from '@nestjs/common';
import { InsufficientFundsError } from '../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { newId } from '../shared/ids';
import { IdempotencyConflictError, UniqueViolationError, ValidationError } from './errors';
import { computePayloadHash } from './payload-hash';
import { UnitOfWork, type WagerStore } from './ports';

export interface SubmitTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the result was produced; null when the wallet is unknown. */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * How long a REFUND/ROLLBACK waits for its reference. With the defaults the
 * attempts happen about 5s, 10s, 20s, 40s, 80s and 160s apart (roughly 5 minutes
 * in total), which covers ordinary out-of-order delivery without keeping a
 * dangling reversal forever.
 */
export const MAX_REFERENCE_ATTEMPTS = Number(process.env.REFERENCE_MAX_ATTEMPTS ?? 6);
export const REFERENCE_RETRY_BASE_MS = Number(process.env.REFERENCE_RETRY_BASE_MS ?? 5_000);

const REVERSIBLE_BY: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/** The single entry point used by both HTTP and the SQS consumer. */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async submit(command: SubmitTransactionCommand): Promise<TransactionResult> {
    if (command.kind === WagerTransactionKind.Opening) {
      throw new ValidationError('OPENING is an internal kind and cannot be submitted');
    }
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash(command);

    // When two identical requests race, the unique constraints let only one
    // insert win. The loser rolls back, runs again and finds the stored
    // transaction, so it answers as a replay instead of failing.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.uow.run((store) => this.submitWithin(store, command, money, payloadHash));
      } catch (error) {
        if (error instanceof UniqueViolationError && attempt < 3) continue;
        throw error;
      }
    }
  }

  /** Called by the retry worker for a transaction waiting in PENDING_REFERENCE. */
  async retryPendingReference(transactionId: string, correlationId: string): Promise<TransactionResult | null> {
    return this.uow.run(async (store) => {
      const unlocked = await store.findTransactionById(transactionId);
      if (!unlocked) return null;
      const wallet = await store.lockWallet(unlocked.walletId);
      // Read again after taking the lock: another instance may have resolved it.
      const tx = await store.findTransactionById(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return null;

      const now = new Date();
      const entry = await this.apply(store, tx, wallet, now);
      await store.updateTransaction(tx);
      await this.persistEffects(store, tx, wallet, entry, correlationId, now, false);
      return this.toResult(tx, wallet, false);
    });
  }

  private async submitWithin(
    store: WagerStore,
    command: SubmitTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<TransactionResult> {
    // The wallet row lock serializes every operation on this wallet, across all
    // instances. Different wallets do not wait for each other.
    const wallet = await store.lockWallet(command.walletId);

    const existing =
      (await store.findTransactionByIdempotencyKey(command.idempotencyKey)) ??
      (await store.findTransactionByExternalId(command.providerId, command.externalTransactionId));
    if (existing) {
      if (existing.idempotencyKey !== command.idempotencyKey || !existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError();
      }
      return this.toResult(existing, wallet, true);
    }

    const now = new Date();
    const tx = WagerTransaction.create({
      id: newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const entry = await this.apply(store, tx, wallet, now);
    await store.insertTransaction(tx, command.correlationId);
    await this.persistEffects(store, tx, wallet, entry, command.correlationId, now, true);
    return this.toResult(tx, wallet, false);
  }

  /**
   * Decides the outcome of the transaction and applies it to the in-memory
   * wallet. Returns the ledger entry when the balance moved.
   */
  private async apply(
    store: WagerStore,
    tx: WagerTransaction,
    wallet: Wallet | null,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (!wallet) {
      tx.reject(FailureCode.WalletNotFound, undefined, now);
      return undefined;
    }
    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, wallet.balance, now);
      return undefined;
    }
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, wallet.balance, now);
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (tx.requiresReference()) {
      const found = await store.findTransactionByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId as string,
      );
      if (!found || !found.isTerminal()) {
        // The reference has not arrived (or is itself still waiting).
        if (tx.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
          tx.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
        } else {
          const delay = REFERENCE_RETRY_BASE_MS * 2 ** tx.referenceAttempts;
          tx.markPendingReference(new Date(now.getTime() + delay));
        }
        return undefined;
      }
      const failure =
        this.validateReference(tx, found) ??
        ((await store.hasProcessedReversal(found.id, tx.kind))
          ? FailureCode.ReferenceAlreadyReversed
          : undefined);
      if (failure) {
        tx.reject(failure, wallet.balance, now);
        return undefined;
      }
      reference = found;
    } else if (tx.referenceExternalTransactionId) {
      // WIN and LOSS may point to the BET of the round. The link is informative:
      // it is stored when it matches and ignored otherwise.
      const found = await store.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (
        found &&
        found.kind === WagerTransactionKind.Bet &&
        found.walletId === tx.walletId &&
        found.roundId === tx.roundId
      ) {
        reference = found;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, wallet.balance, now);
      return undefined;
    }

    const movement = { entryId: newId(), transactionId: tx.id, money: tx.money, at: now };
    try {
      const entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      tx.markProcessed(reference?.id, wallet.balance, now);
      return entry;
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // A bet without funds and a reversal that would overdraw the wallet are
      // different situations for the provider, so they get different codes.
      const code =
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalWouldOverdraw;
      tx.reject(code, wallet.balance, now);
      return undefined;
    }
  }

  private validateReference(tx: WagerTransaction, reference: WagerTransaction): FailureCode | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.roundId !== tx.roundId ||
      reference.money.currency !== tx.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!REVERSIBLE_BY[tx.kind]?.includes(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (!reference.money.equals(tx.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  /** Wallet, ledger and outbox rows, written in the same SQL transaction. */
  private async persistEffects(
    store: WagerStore,
    tx: WagerTransaction,
    wallet: Wallet | null,
    entry: WalletLedgerEntry | undefined,
    correlationId: string,
    now: Date,
    firstSubmission: boolean,
  ): Promise<void> {
    const ctx = (): EventContext => ({
      eventId: newId(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    if (entry && wallet) {
      await store.updateWallet(wallet);
      await store.insertLedgerEntry(entry);
    }

    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        await store.enqueueOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx())));
        if (entry && wallet) {
          await store.enqueueOutbox(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx())));
        }
        break;
      case WagerTransactionStatus.Rejected:
        await store.enqueueOutbox(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx())));
        break;
      case WagerTransactionStatus.PendingReference:
        // Announced once, when the transaction first starts waiting.
        if (firstSubmission) {
          await store.enqueueOutbox(
            OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx())),
          );
        }
        break;
      default:
        break;
    }
  }

  private toResult(tx: WagerTransaction, wallet: Wallet | null, replay: boolean): TransactionResult {
    const balance = tx.resultBalance ?? wallet?.balance;
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: balance ? balance.toJSON() : null,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: replay,
    };
  }
}
