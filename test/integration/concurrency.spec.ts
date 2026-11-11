import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import {
  balanceOf,
  command,
  countInconsistentWallets,
  createTestContext,
  ledgerMatchesBalance,
  ledgerOf,
  openWallet,
  type TestContext,
} from './support/context';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  expect(await countInconsistentWallets(ctx)).toBe(0);
  await ctx.orm.close(true);
});

// Every Promise.all below runs on separate database connections at the same
// time: the requests really race inside PostgreSQL.
describe('concurrency on one wallet', () => {
  it('mandatory scenario: two 80.00 bets on a 100.00 balance', async () => {
    const target = await openWallet(ctx, '100.00');
    const results = await Promise.all([
      ctx.process.submit(command(target, Kind.Bet, '80.00')),
      ctx.process.submit(command(target, Kind.Bet, '80.00')),
    ]);

    const processed = results.filter((r) => r.status === Status.Processed);
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(ctx, target.walletId)).toBe('20.00');
    const debits = (await ledgerOf(ctx, target.walletId)).filter((e) => e.direction === 'DEBIT');
    expect(debits).toEqual([{ direction: 'DEBIT', amount: '80.00', before: '100.00', after: '20.00' }]);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('the same bet sent 50 times in parallel debits once', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = command(target, Kind.Bet, '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => ctx.process.submit(bet)));

    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.balance?.amount === '90.00')).toBe(true);
    expect(await balanceOf(ctx, target.walletId)).toBe('90.00');
    expect((await ledgerOf(ctx, target.walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  it('the same bet for an unknown wallet, sent in parallel, is stored once', async () => {
    const bet = command({ walletId: '00000000-0000-7000-8000-00000000dead', playerId: 'ghost' }, Kind.Bet, '1.00');
    const results = await Promise.all(Array.from({ length: 20 }, () => ctx.process.submit(bet)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.failureCode === FailureCode.WalletNotFound)).toBe(true);
  });

  it('30 different bets of 10.00 on 100.00: exactly 10 win the race, never negative', async () => {
    const target = await openWallet(ctx, '100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => ctx.process.submit(command(target, Kind.Bet, '10.00'))),
    );
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(20);
    expect(await balanceOf(ctx, target.walletId)).toBe('0.00');
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('mixed credits and debits keep every ledger entry chained to the previous one', async () => {
    const target = await openWallet(ctx, '50.00');
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ctx.process.submit(command(target, i % 2 ? Kind.Win : Kind.Bet, i % 2 ? '7.00' : '3.00')),
      ),
    );
    const ledger = await ledgerOf(ctx, target.walletId);
    for (let i = 1; i < ledger.length; i += 1) {
      expect(ledger[i].before).toBe(ledger[i - 1].after); // no lost update
    }
    expect(await balanceOf(ctx, target.walletId)).toBe(ledger[ledger.length - 1].after as string);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('a reference can be reversed only once even when the reversals race', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = command(target, Kind.Bet, '40.00');
    await ctx.process.submit(bet);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.process.submit(
          command(target, Kind.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(9);
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
  });
});

describe('concurrency across wallets', () => {
  it('different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(ctx, '100.00')));
    await Promise.all(
      wallets.flatMap((target) =>
        Array.from({ length: 6 }, () => ctx.process.submit(command(target, Kind.Bet, '15.00'))),
      ),
    );
    for (const target of wallets) {
      expect(await balanceOf(ctx, target.walletId)).toBe('10.00');
      expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
    }
  });
});
