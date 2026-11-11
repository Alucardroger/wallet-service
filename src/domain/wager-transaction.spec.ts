import { describe, expect, it } from 'bun:test';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T12:00:00.000Z');
const later = new Date('2026-11-11T12:00:05.000Z');

const make = (kind: Kind, extra: { amount?: string; ref?: string } = {}) =>
  WagerTransaction.create({
    id: `id-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `provider-a:ext-${kind}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(extra.amount ?? '25.00'),
    referenceExternalTransactionId: extra.ref,
    createdAt: now,
  });

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    const tx = make(Kind.Bet);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it('requires a reference for REFUND and ROLLBACK only', () => {
    expect(() => make(Kind.Refund)).toThrow(InvalidTransactionError);
    expect(() => make(Kind.Rollback)).toThrow(InvalidTransactionError);
    expect(make(Kind.Refund, { ref: 'ext-BET' }).requiresReference()).toBe(true);
    expect(make(Kind.Win).requiresReference()).toBe(false);
  });

  it('requires a positive amount, except for LOSS', () => {
    expect(() => make(Kind.Bet, { amount: '0.00' })).toThrow(InvalidTransactionError);
    expect(make(Kind.Loss, { amount: '0.00' }).affectsBalance()).toBe(false);
    expect(make(Kind.Bet).affectsBalance()).toBe(true);
  });

  it('PENDING -> PROCESSED stores the observed balance', () => {
    const tx = make(Kind.Bet);
    tx.markProcessed(undefined, brl('975.00'), later);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance?.toJSON().amount).toBe('975.00');
    expect(tx.processedAt).toEqual(later);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> REJECTED keeps the failure code', () => {
    const tx = make(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'), later);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('terminal states never change again', () => {
    const processed = make(Kind.Bet);
    processed.markProcessed(undefined, brl('1.00'), later);
    expect(() => processed.reject(FailureCode.InsufficientFunds, undefined, later)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, brl('1.00'), later)).toThrow(InvalidTransactionStateError);

    const rejected = make(Kind.Win);
    rejected.reject(FailureCode.WalletNotFound, undefined, later);
    expect(() => rejected.fail(FailureCode.InfrastructureFailure, later)).toThrow(InvalidTransactionStateError);

    const failed = make(Kind.Win);
    failed.fail(FailureCode.InfrastructureFailure, later);
    expect(() => failed.markProcessed(undefined, brl('1.00'), later)).toThrow(InvalidTransactionStateError);
  });

  it('waits for a missing reference, counting attempts, then resolves', () => {
    const tx = make(Kind.Rollback, { ref: 'ext-BET' });
    tx.markPendingReference(later);
    tx.markPendingReference(later);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt).toEqual(later);
    tx.markProcessed('id-BET', brl('100.00'), later);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('id-BET');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  it('can be rejected after waiting for a reference that never arrives', () => {
    const tx = make(Kind.Refund, { ref: 'ext-BET' });
    tx.markPendingReference(later);
    tx.reject(FailureCode.ReferenceNotFound, undefined, later);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('refuses invalid uses of the reference transitions', () => {
    expect(() => make(Kind.Bet).markPendingReference(later)).toThrow(InvalidTransactionError);
    const refund = make(Kind.Refund, { ref: 'ext-BET' });
    expect(() => refund.markProcessed(undefined, brl('1.00'), later)).toThrow(InvalidTransactionError);
  });

  it('knows the ledger direction of each kind', () => {
    const bet = make(Kind.Bet);
    const win = make(Kind.Win);
    const refund = make(Kind.Refund, { ref: 'ext-BET' });
    const rollback = make(Kind.Rollback, { ref: 'x' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Opening).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => make(Kind.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  it('detects a different payload under the same idempotency key', () => {
    const tx = make(Kind.Bet);
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('hash-2')).toBe(false);
  });

  it('round-trips through its state', () => {
    const tx = make(Kind.Bet);
    tx.markProcessed(undefined, brl('5.00'), later);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.status).toBe(Status.Processed);
    expect(copy.resultBalance?.equals(brl('5.00'))).toBe(true);
  });
});