import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, sqlRunner, TEST_DATABASE_URL, type Sql } from './support/database';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const TX = '0192f298-345e-7e38-af88-e43f851a819d';
const NOW = '2026-11-11T12:00:00.000Z';

let orm: MikroORM;
let sql: Sql;
let counter = 0;
const uuid = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

const insertWallet = (id: string, player: string, balance = '100.00', currency = 'BRL') =>
  sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, ?, ?)`,
    [id, player, currency, balance, NOW, NOW],
  );

const insertTx = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: `ext-${counter}`,
    idempotency_key: `provider-a:ext-${counter}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: WALLET,
    player_id: 'player-1',
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: NOW,
    ...over,
  };
  const columns = Object.keys(row);
  return sql(
    `insert into wager_transactions (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
};

const insertEntry = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: uuid(),
    wallet_id: WALLET,
    transaction_id: TX,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: NOW,
    ...over,
  };
  const columns = Object.keys(row);
  return sql(
    `insert into wallet_ledger_entries (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
};

/** Asserts that the statement is refused by the named constraint (or message). */
async function expectViolation(action: () => Promise<unknown>, expected: string): Promise<void> {
  let message = '';
  try {
    await action();
  } catch (error) {
    const e = error as { message?: string; constraint?: string };
    message = `${e.constraint ?? ''} ${e.message ?? ''}`;
  }
  expect(message).toContain(expected);
}

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  await insertWallet(WALLET, 'player-1');
  await insertTx({ id: TX, external_transaction_id: 'ext-base', idempotency_key: 'provider-a:ext-base' });
});

afterAll(async () => {
  await orm?.close(true);
});

describe('migrations', () => {
  it('creates every table', async () => {
    const rows = await sql(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'schema_migrations',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });

  it('is reversible: down removes the schema and up restores it', async () => {
    // Uses its own database so that rolling back does not disturb the other tests.
    const other = await createTestOrm(TEST_DATABASE_URL + '_migrations');
    const tables = async () =>
      (
        await sqlRunner(other)(
          `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
        )
      ).map((r) => r.table_name);
    try {
      expect(await tables()).toContain('wallet_ledger_entries');
      await other.migrator.down();
      expect(await tables()).toEqual(['schema_migrations']);
      await other.migrator.up();
      expect(await tables()).toContain('wallet_ledger_entries');
    } finally {
      await other.close(true);
    }
  });
});

describe('wallets constraints', () => {
  it('allows only one wallet per player and currency', async () => {
    await expectViolation(() => insertWallet(uuid(), 'player-1'), 'wallets_player_currency_uq');
    await insertWallet(uuid(), 'player-1', '5.00', 'USD'); // another currency is fine
  });

  it('never stores a negative balance', async () => {
    await expectViolation(() => insertWallet(uuid(), 'player-neg', '-0.01'), 'wallets_balance_non_negative_ck');
    await expectViolation(
      () => sql(`update wallets set balance = balance - 1000 where id = ?`, [WALLET]),
      'wallets_balance_non_negative_ck',
    );
  });

  it('stores money exactly', async () => {
    const id = uuid();
    await insertWallet(id, 'player-exact', '0.10');
    await sql(`update wallets set balance = balance + 0.20 where id = ?`, [id]);
    const [row] = await sql(`select balance::text as balance from wallets where id = ?`, [id]);
    expect(row.balance).toBe('0.30');
  });
});

describe('wager_transactions constraints', () => {
  it('refuses a repeated idempotency key', async () => {
    await expectViolation(
      () => insertTx({ idempotency_key: 'provider-a:ext-base' }),
      'wager_tx_idempotency_key_uq',
    );
  });

  it('refuses a repeated provider + external id', async () => {
    await expectViolation(
      () => insertTx({ external_transaction_id: 'ext-base' }),
      'wager_tx_provider_external_uq',
    );
  });

  it('refuses unknown kinds and statuses', async () => {
    await expectViolation(() => insertTx({ kind: 'BONUS' }), 'wager_tx_kind_ck');
    await expectViolation(() => insertTx({ status: 'DONE' }), 'wager_tx_status_ck');
  });

  it('requires a reference for REFUND and ROLLBACK', async () => {
    await expectViolation(() => insertTx({ kind: 'REFUND' }), 'wager_tx_reference_required_ck');
    await expectViolation(() => insertTx({ kind: 'ROLLBACK' }), 'wager_tx_reference_required_ck');
  });

  it('keeps terminal status, timestamp and failure code consistent', async () => {
    await expectViolation(() => insertTx({ status: 'PROCESSED' }), 'wager_tx_terminal_timestamp_ck');
    await expectViolation(
      () => insertTx({ status: 'REJECTED', processed_at: NOW }),
      'wager_tx_failure_code_ck',
    );
  });

  it('lets a reference be reversed only once per kind', async () => {
    const reversal = (kind: string) =>
      insertTx({
        kind,
        reference_external_transaction_id: 'ext-base',
        reference_transaction_id: TX,
        status: 'PROCESSED',
        processed_at: NOW,
      });
    await reversal('REFUND');
    await expectViolation(() => reversal('REFUND'), 'wager_tx_single_reversal_uq');
    await reversal('ROLLBACK'); // a different kind of reversal is a separate slot
    await expectViolation(() => reversal('ROLLBACK'), 'wager_tx_single_reversal_uq');
  });
});

describe('wallet_ledger_entries constraints', () => {
  it('accepts a balanced entry, and only one per transaction and wallet', async () => {
    await insertEntry();
    await expectViolation(() => insertEntry(), 'ledger_one_entry_per_tx_wallet_uq');
  });

  it('refuses wrong arithmetic, zero amounts and negative balances', async () => {
    const tx = uuid();
    await insertTx({ id: tx });
    await expectViolation(
      () => insertEntry({ transaction_id: tx, balance_after: '95.00' }),
      'ledger_arithmetic_ck',
    );
    await expectViolation(
      () => insertEntry({ transaction_id: tx, amount: '0.00', balance_after: '100.00' }),
      'ledger_amount_positive_ck',
    );
    await expectViolation(
      () => insertEntry({ transaction_id: tx, amount: '150.00', balance_after: '-50.00' }),
      'ledger_balances_non_negative_ck',
    );
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    await expectViolation(() => sql(`update wallet_ledger_entries set amount = 1`), 'append-only');
    await expectViolation(() => sql(`delete from wallet_ledger_entries`), 'append-only');
    await expectViolation(() => sql(`truncate wallet_ledger_entries`), 'append-only');
    const [row] = await sql(`select count(*)::int as n from wallet_ledger_entries`);
    expect(row.n).toBe(1);
  });
});

describe('inbox_messages constraints', () => {
  it('stores each message once per consumer', async () => {
    const insert = (consumer: string) =>
      sql(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)`,
        [consumer, 'msg-123', 'b'.repeat(64), NOW],
      );
    await insert('wager-consumer');
    await expectViolation(() => insert('wager-consumer'), 'inbox_messages_pkey');
    await insert('another-consumer');
  });
});
