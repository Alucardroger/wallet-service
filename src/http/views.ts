import type { LedgerPageItem } from '../application/ports';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export const walletView = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const transactionView = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  balance: tx.resultBalance?.toJSON() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

export const ledgerEntryView = ({ entry }: LedgerPageItem) => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  createdAt: entry.createdAt.toISOString(),
});
