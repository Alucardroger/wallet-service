import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidLedgerEntryError,
} from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T12:00:00.000Z');
let seq = 0;
const move = (amount: string, currency = 'BRL') => ({
  entryId: `entry-${++seq}`,
  transactionId: `tx-${seq}`,
  money: Money.from({ amount, currency }),
  at: now,
});
const openWith = (amount: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    at: now,
    opening: { entryId: 'entry-open', transactionId: 'tx-open' },
  });

describe('Wallet', () => {
  it('opens at version 1 with an opening CREDIT entry', () => {
    const { wallet, openingEntry } = openWith('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  it('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w', playerId: 'p', initialBalance: brl('0.00'), at: now,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('requires an opening transaction for a positive initial balance', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('5.00'), at: now }),
    ).toThrow(InvalidAmountError);
  });

  it('debits: balance goes down, version goes up, entry matches', () => {
    const { wallet } = openWith('100.00');
    const entry = wallet.debit(move('80.00'));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects a debit above the balance and leaves the wallet untouched', () => {
    const { wallet } = openWith('100.00');
    wallet.debit(move('80.00'));
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('allows a debit of the exact balance', () => {
    const { wallet } = openWith('50.00');
    wallet.debit(move('50.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('credits: balance and version go up', () => {
    const { wallet } = openWith('10.00');
    const entry = wallet.credit(move('15.50'));
    expect(wallet.balance.toJSON().amount).toBe('25.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('rejects another currency and zero amounts without changing state', () => {
    const { wallet } = openWith('10.00');
    expect(() => wallet.debit(move('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move('0.00'))).toThrow(InvalidAmountError);
    expect(wallet.version).toBe(1);
  });

  it('keeps the balance equal to the sum of its ledger entries', () => {
    const { wallet, openingEntry } = openWith('100.00');
    const entries = [
      openingEntry!,
      wallet.debit(move('30.00')),
      wallet.credit(move('12.34')),
      wallet.debit(move('0.34')),
    ];
    const rebuilt = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: now,
    direction: LedgerDirection.Debit,
    money: brl('10.00'), balanceBefore: brl('50.00'), balanceAfter: brl('40.00'),
  };

  it('accepts a balanced entry', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  it('rejects wrong arithmetic and non-positive amounts', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('50.00') })).toThrow(InvalidLedgerEntryError);
  });
});