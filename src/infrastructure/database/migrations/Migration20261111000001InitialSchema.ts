import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. The guarantees of uniqueness, immutability and
 * non-negativity live here, in the database, not only in application code.
 */
export class Migration20261111000001InitialSchema extends Migration {
  override name = 'Migration20261111000001InitialSchema';

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text not null check (length(player_id) between 1 and 128),
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null,
        version     integer not null,
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_balance_non_negative_ck check (balance >= 0),
        constraint wallets_version_ck check (version >= 1)
      );
    `);

    // ----------------------------------------------------- wager_transactions
    // wallet_id has no foreign key on purpose: a transaction sent to an unknown
    // wallet is stored as REJECTED so that it stays auditable.
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null,
        external_transaction_id            text not null,
        idempotency_key                    text not null,
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null,
        player_id                          text not null,
        round_id                           text not null,
        game_id                            text not null,
        kind                               text not null,
        amount                             numeric(20,2) not null,
        currency                           char(3) not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text not null,
        failure_code                       text,
        result_balance                     numeric(20,2),
        reference_attempts                 integer not null default 0,
        next_reference_attempt_at          timestamptz,
        correlation_id                     text,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_kind_ck check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_ck check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_amount_ck check (amount >= 0),
        constraint wager_tx_reference_required_ck check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_tx_terminal_timestamp_ck check (
          (status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)
        ),
        constraint wager_tx_failure_code_ck check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        )
      );
    `);
    // A reference can be reversed only once per kind of operation.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    // Work queue of the PENDING_REFERENCE retry worker.
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    // -------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        seq             bigint generated always as identity,
        wallet_id       uuid not null references wallets (id),
        transaction_id  uuid not null references wager_transactions (id),
        direction       text not null,
        amount          numeric(20,2) not null,
        currency        char(3) not null,
        balance_before  numeric(20,2) not null,
        balance_after   numeric(20,2) not null,
        created_at      timestamptz not null,
        constraint ledger_one_entry_per_tx_wallet_uq unique (transaction_id, wallet_id),
        constraint ledger_direction_ck check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive_ck check (amount > 0),
        constraint ledger_balances_non_negative_ck check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic_ck check (
          balance_after = case direction
            when 'DEBIT' then balance_before - amount
            else balance_before + amount
          end
        )
      );
    `);
    // Stable order for the ledger cursor and for reconciliation.
    this.addSql(`create unique index ledger_wallet_seq_uq on wallet_ledger_entries (wallet_id, seq);`);
    // Append-only: no UPDATE, DELETE or TRUNCATE, for any database user.
    this.addSql(`
      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation();
    `);

    // --------------------------------------------------------- inbox_messages
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    // -------------------------------------------------------- outbox_messages
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        seq              bigint generated always as identity,
        aggregate_id     text not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        constraint outbox_attempts_ck check (attempts >= 0)
      );
    `);
    // Work queue of the outbox publisher: only unpublished rows, in order.
    this.addSql(`create index outbox_pending_idx on outbox_messages (seq) where published_at is null;`);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists forbid_ledger_mutation();`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
