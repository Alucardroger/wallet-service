import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

/**
 * Everything a use case may read or write inside ONE database transaction.
 * Writes are sent to the database in the order they are called.
 */
export interface WagerStore {
  /** Loads the wallet and locks its row until the transaction ends. */
  lockWallet(walletId: string): Promise<Wallet | null>;
  findTransactionById(id: string): Promise<WagerTransaction | null>;
  findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  /** True when a PROCESSED reversal of this kind already points to the reference. */
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  insertWallet(wallet: Wallet): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;
  insertTransaction(tx: WagerTransaction, correlationId: string): Promise<void>;
  updateTransaction(tx: WagerTransaction): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  enqueueOutbox(message: OutboxMessage): Promise<void>;
}

/** Runs the work in one SQL transaction: everything commits together or nothing does. */
export abstract class UnitOfWork {
  abstract run<T>(work: (store: WagerStore) => Promise<T>): Promise<T>;
}

export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

/** Read-only queries, outside any transaction. */
export abstract class WalletQueries {
  abstract findWallet(walletId: string): Promise<Wallet | null>;
  abstract findTransaction(id: string): Promise<WagerTransaction | null>;
  abstract findTransactionByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null>;
  /** Entries after the given position, oldest first. */
  abstract ledgerPage(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerPageItem[]>;
}
