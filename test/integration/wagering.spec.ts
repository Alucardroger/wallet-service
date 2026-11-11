import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../../src/application/errors';
import type { UnitOfWork, WagerStore } from '../../src/application/ports';
import {
  MAX_REFERENCE_ATTEMPTS,
  ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import {
  balanceOf,
  command,
  countInconsistentWallets,
  createTestContext,
  eventTypesFor,
  ledgerMatchesBalance,
  ledgerOf,
  openWallet,
  unique,
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

describe('opening a wallet', () => {
  it('stores wallet, OPENING transaction, CREDIT entry and events together', async () => {
    const wallet = await ctx.openWallet.execute({
      playerId: unique('player'),
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'test',
    });
    expect(wallet.version).toBe(1);
    expect(await balanceOf(ctx, wallet.id)).toBe('1000.00');
    expect(await ledgerOf(ctx, wallet.id)).toEqual([
      { direction: 'CREDIT', amount: '1000.00', before: '0.00', after: '1000.00' },
    ]);
    const [opening] = await ctx.sql(`select id, kind, status from wager_transactions where wallet_id = ?`, [
      wallet.id,
    ]);
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await eventTypesFor(ctx, opening.id as string)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(ctx, wallet.id)).toEqual(['WalletBalanceChanged']);
  });

  it('opens with zero balance without any ledger entry', async () => {
    const { walletId } = await openWallet(ctx, '0.00');
    expect(await ledgerOf(ctx, walletId)).toEqual([]);
    expect(await ledgerMatchesBalance(ctx, walletId)).toBe(true);
  });

  it('refuses a second wallet for the same player and currency', async () => {
    const playerId = unique('player');
    const open = () =>
      ctx.openWallet.execute({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' }, correlationId: 't' });
    await open();
    await expect(open()).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});

describe('BET, WIN and LOSS', () => {
  it('BET debits, WIN credits, LOSS only records the result', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = await ctx.process.submit(command(target, Kind.Bet, '25.00', { externalTransactionId: unique('bet') }));
    expect(bet).toMatchObject({ status: Status.Processed, balance: { amount: '75.00' }, idempotentReplay: false });

    const win = await ctx.process.submit(command(target, Kind.Win, '60.00'));
    expect(win.balance?.amount).toBe('135.00');

    const loss = await ctx.process.submit(command(target, Kind.Loss, '25.00'));
    expect(loss).toMatchObject({ status: Status.Processed, balance: { amount: '135.00' } });

    expect(await ledgerOf(ctx, target.walletId)).toEqual([
      { direction: 'CREDIT', amount: '100.00', before: '0.00', after: '100.00' },
      { direction: 'DEBIT', amount: '25.00', before: '100.00', after: '75.00' },
      { direction: 'CREDIT', amount: '60.00', before: '75.00', after: '135.00' },
    ]);
    const [wallet] = await ctx.sql(`select version from wallets where id = ?`, [target.walletId]);
    expect(wallet.version).toBe(3); // 1 at creation, +1 per balance change, LOSS does not count
    expect(await eventTypesFor(ctx, bet.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(ctx, loss.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await eventTypesFor(ctx, target.walletId)).toEqual([
      'WalletBalanceChanged',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('rejects a BET above the balance without touching balance or ledger', async () => {
    const target = await openWallet(ctx, '10.00');
    const result = await ctx.process.submit(command(target, Kind.Bet, '10.01'));
    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: '10.00' },
    });
    expect(await balanceOf(ctx, target.walletId)).toBe('10.00');
    expect(await ledgerOf(ctx, target.walletId)).toHaveLength(1);
    expect(await eventTypesFor(ctx, result.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  it('rejects an unknown wallet, a wallet of another player and another currency, keeping them auditable', async () => {
    const target = await openWallet(ctx, '10.00');
    const missing = await ctx.process.submit(
      command({ walletId: '00000000-0000-7000-8000-000000000000', playerId: 'nobody' }, Kind.Bet, '1.00'),
    );
    expect(missing).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.WalletNotFound, balance: null });

    const stranger = await ctx.process.submit(command({ ...target, playerId: 'someone-else' }, Kind.Bet, '1.00'));
    expect(stranger.failureCode).toBe(FailureCode.WalletPlayerMismatch);

    const usd = await ctx.process.submit(
      command(target, Kind.Bet, '1.00', { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(usd.failureCode).toBe(FailureCode.CurrencyMismatch);

    const stored = await ctx.sql(`select status from wager_transactions where id in (?, ?, ?)`, [
      missing.transactionId,
      stranger.transactionId,
      usd.transactionId,
    ]);
    expect(stored.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED', 'REJECTED']);
    expect(await balanceOf(ctx, target.walletId)).toBe('10.00');
  });
});

describe('idempotency', () => {
  it('replays the original result, with the balance observed at that time', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = command(target, Kind.Bet, '30.00');
    const first = await ctx.process.submit(bet);
    await ctx.process.submit(command(target, Kind.Win, '500.00')); // balance moves on
    const replay = await ctx.process.submit(bet);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('70.00');
    expect(await balanceOf(ctx, target.walletId)).toBe('570.00');
    expect(await ledgerOf(ctx, target.walletId)).toHaveLength(3);
  });

  it('replays a rejection as the same rejection', async () => {
    const target = await openWallet(ctx, '5.00');
    const bet = command(target, Kind.Bet, '50.00');
    const first = await ctx.process.submit(bet);
    await ctx.process.submit(command(target, Kind.Win, '500.00')); // now there would be funds
    const replay = await ctx.process.submit(bet);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.status).toBe(Status.Rejected);
  });

  it('treats the same key with a different payload as a conflict, not a replay', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = command(target, Kind.Bet, '10.00');
    await ctx.process.submit(bet);
    await expect(ctx.process.submit({ ...bet, money: { amount: '99.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    // Same provider transaction under another key is also a conflict.
    await expect(ctx.process.submit({ ...bet, idempotencyKey: unique('other-key') })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await balanceOf(ctx, target.walletId)).toBe('90.00');
  });
});

describe('REFUND and ROLLBACK', () => {
  const placeBet = async (target: { walletId: string; playerId: string }, amount: string) => {
    const externalTransactionId = unique('bet');
    await ctx.process.submit(command(target, Kind.Bet, amount, { externalTransactionId }));
    return externalTransactionId;
  };

  it('REFUND gives the BET back, once', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = await placeBet(target, '40.00');
    const refund = await ctx.process.submit(
      command(target, Kind.Refund, '40.00', { referenceExternalTransactionId: bet }),
    );
    expect(refund).toMatchObject({ status: Status.Processed, balance: { amount: '100.00' } });

    const again = await ctx.process.submit(
      command(target, Kind.Refund, '40.00', { referenceExternalTransactionId: bet }),
    );
    expect(again).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAlreadyReversed });
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('ROLLBACK does the inverse of what it references', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = await placeBet(target, '40.00'); // 60
    const win = unique('win');
    await ctx.process.submit(command(target, Kind.Win, '15.00', { externalTransactionId: win })); // 75

    const undoWin = await ctx.process.submit(
      command(target, Kind.Rollback, '15.00', { referenceExternalTransactionId: win }),
    );
    expect(undoWin.balance?.amount).toBe('60.00');
    const undoBet = await ctx.process.submit(
      command(target, Kind.Rollback, '40.00', { referenceExternalTransactionId: bet }),
    );
    expect(undoBet.balance?.amount).toBe('100.00');

    const ledger = await ledgerOf(ctx, target.walletId);
    expect(ledger.slice(-2).map((e) => e.direction)).toEqual(['DEBIT', 'CREDIT']);
  });

  it('validates kind, amount, round and state of the reference', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = await placeBet(target, '40.00');
    const win = unique('win');
    await ctx.process.submit(command(target, Kind.Win, '5.00', { externalTransactionId: win }));
    const rejectedBet = unique('bet');
    await ctx.process.submit(command(target, Kind.Bet, '9999.00', { externalTransactionId: rejectedBet }));

    const submit = (kind: Kind, amount: string, extra: object) =>
      ctx.process.submit(command(target, kind, amount, extra)).then((r) => r.failureCode);

    expect(await submit(Kind.Refund, '5.00', { referenceExternalTransactionId: win })).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
    expect(await submit(Kind.Refund, '39.99', { referenceExternalTransactionId: bet })).toBe(
      FailureCode.AmountMismatch,
    );
    expect(await submit(Kind.Refund, '40.00', { referenceExternalTransactionId: bet, roundId: 'round-2' })).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(await submit(Kind.Rollback, '9999.00', { referenceExternalTransactionId: rejectedBet })).toBe(
      FailureCode.ReferenceNotProcessed,
    );
    expect(await balanceOf(ctx, target.walletId)).toBe('65.00');
  });

  it('rejects a reversal that would overdraw, with its own failure code', async () => {
    const target = await openWallet(ctx, '0.00');
    const win = unique('win');
    await ctx.process.submit(command(target, Kind.Win, '50.00', { externalTransactionId: win }));
    await ctx.process.submit(command(target, Kind.Bet, '30.00')); // 20 left
    const rollback = await ctx.process.submit(
      command(target, Kind.Rollback, '50.00', { referenceExternalTransactionId: win }),
    );
    expect(rollback).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReversalWouldOverdraw,
      balance: { amount: '20.00' },
    });
    expect(await balanceOf(ctx, target.walletId)).toBe('20.00');
  });
});

describe('references out of order', () => {
  it('waits in PENDING_REFERENCE and resolves once the reference arrives', async () => {
    const target = await openWallet(ctx, '100.00');
    const bet = unique('bet');
    const rollback = command(target, Kind.Rollback, '40.00', { referenceExternalTransactionId: bet });

    const early = await ctx.process.submit(rollback);
    expect(early).toMatchObject({ status: Status.PendingReference, balance: { amount: '100.00' } });
    expect(await eventTypesFor(ctx, early.transactionId)).toEqual(['WagerTransactionPendingReference']);
    expect((await ctx.process.submit(rollback)).idempotentReplay).toBe(true);

    await ctx.process.submit(command(target, Kind.Bet, '40.00', { externalTransactionId: bet }));
    expect(await balanceOf(ctx, target.walletId)).toBe('60.00');

    const resolved = await ctx.process.retryPendingReference(early.transactionId, 'retry');
    expect(resolved).toMatchObject({ status: Status.Processed, balance: { amount: '100.00' } });
    expect(await ctx.process.retryPendingReference(early.transactionId, 'retry')).toBeNull(); // already done
    expect(await eventTypesFor(ctx, early.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    expect(await ledgerMatchesBalance(ctx, target.walletId)).toBe(true);
  });

  it('gives up after the attempt limit with REFERENCE_NOT_FOUND', async () => {
    const target = await openWallet(ctx, '100.00');
    const early = await ctx.process.submit(
      command(target, Kind.Refund, '10.00', { referenceExternalTransactionId: unique('never') }),
    );
    let last = early;
    for (let i = 0; i < MAX_REFERENCE_ATTEMPTS; i += 1) {
      last = (await ctx.process.retryPendingReference(early.transactionId, 'retry')) ?? last;
    }
    expect(last).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceNotFound });
    expect(await eventTypesFor(ctx, early.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
  });
});

describe('atomicity', () => {
  it('rolls back transaction, balance and ledger when the outbox write fails', async () => {
    const target = await openWallet(ctx, '100.00');
    // Same real database, but the last step of the unit of work blows up.
    const failingUow: UnitOfWork = {
      run: (work) =>
        ctx.uow.run((store) =>
          work(
            new Proxy(store, {
              get: (real, prop) =>
                prop === 'enqueueOutbox'
                  ? () => Promise.reject(new Error('outbox unavailable'))
                  : Reflect.get(real, prop).bind(real),
            }) as WagerStore,
          ),
        ),
    };
    const bet = command(target, Kind.Bet, '25.00');
    await expect(new ProcessWagerTransactionUseCase(failingUow).submit(bet)).rejects.toThrow('outbox unavailable');

    expect(await balanceOf(ctx, target.walletId)).toBe('100.00');
    expect(await ledgerOf(ctx, target.walletId)).toHaveLength(1);
    expect(
      await ctx.sql(`select 1 from wager_transactions where idempotency_key = ?`, [bet.idempotencyKey]),
    ).toHaveLength(0);

    // Nothing was half-saved, so the same request works afterwards.
    expect((await ctx.process.submit(bet)).status).toBe(Status.Processed);
    expect(await balanceOf(ctx, target.walletId)).toBe('75.00');
  });
});
