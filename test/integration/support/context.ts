import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../../../src/application/open-wallet.use-case';
import {
  ProcessWagerTransactionUseCase,
  type SubmitTransactionCommand,
} from '../../../src/application/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Metrics } from '../../../src/shared/metrics';
import {
  MikroOrmUnitOfWork,
  MikroOrmWalletQueries,
} from '../../../src/infrastructure/database/mikro-orm.adapter';
import { createTestOrm, sqlRunner, type Sql } from './database';

export interface TestContext {
  orm: MikroORM;
  sql: Sql;
  uow: MikroOrmUnitOfWork;
  metrics: Metrics;
  openWallet: OpenWalletUseCase;
  process: ProcessWagerTransactionUseCase;
  queries: MikroOrmWalletQueries;
}

/** Real use cases over a real PostgreSQL: nothing is mocked. */
export async function createTestContext(): Promise<TestContext> {
  const orm = await createTestOrm();
  process.env.LOG_LEVEL ??= 'silent';
  const metrics = new Metrics();
  const uow = new MikroOrmUnitOfWork(orm, metrics);
  return {
    orm,
    sql: sqlRunner(orm),
    uow,
    metrics,
    openWallet: new OpenWalletUseCase(uow),
    process: new ProcessWagerTransactionUseCase(uow, metrics),
    queries: new MikroOrmWalletQueries(orm),
  };
}

let sequence = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++sequence}`;

export async function openWallet(ctx: TestContext, amount = '100.00', currency = 'BRL') {
  const playerId = unique('player');
  const wallet = await ctx.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'test',
  });
  return { walletId: wallet.id, playerId };
}

export function command(
  target: { walletId: string; playerId: string },
  kind: WagerTransactionKind,
  amount: string,
  extra: Partial<SubmitTransactionCommand> = {},
): SubmitTransactionCommand {
  const externalTransactionId = extra.externalTransactionId ?? unique('ext');
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: target.playerId,
    walletId: target.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: 'test',
    ...extra,
  };
}

export async function balanceOf(ctx: TestContext, walletId: string): Promise<string> {
  const [row] = await ctx.sql(`select balance::text as balance from wallets where id = ?`, [walletId]);
  return row.balance as string;
}

export async function ledgerOf(ctx: TestContext, walletId: string) {
  return ctx.sql(
    `select direction, amount::text as amount, balance_before::text as before, balance_after::text as after
       from wallet_ledger_entries where wallet_id = ? order by seq`,
    [walletId],
  );
}

/** The invariant every test must leave true: wallet.balance == balance rebuilt from the ledger. */
export async function ledgerMatchesBalance(ctx: TestContext, walletId: string): Promise<boolean> {
  const [row] = await ctx.sql(
    `select w.balance = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as ok
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  return row.ok === true;
}

/** No wallet in the whole database disagrees with its ledger. */
export async function countInconsistentWallets(ctx: TestContext): Promise<number> {
  const [row] = await ctx.sql(
    `select count(*)::int as n from (
       select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        group by w.id
       having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)
     ) broken`,
  );
  return row.n as number;
}

export const eventTypesFor = async (ctx: TestContext, aggregateId: string): Promise<string[]> =>
  (
    await ctx.sql(`select event_type from outbox_messages where aggregate_id = ? order by seq`, [aggregateId])
  ).map((r) => r.event_type as string);
