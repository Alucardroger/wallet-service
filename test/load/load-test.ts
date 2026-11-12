/**
 * Load test: bun run test:load
 *
 * Starts N real application processes (default 3) on a dedicated database and
 * dedicated queues, drives them over HTTP with closed-loop virtual users and
 * reports throughput, latency percentiles, error rate, concurrency conflicts
 * and outbox lag. Needs only PostgreSQL and SQS (docker compose up -d postgres ministack).
 *
 * Settings (environment variables):
 *   LOAD_DURATION_SECONDS  seconds per scenario           (default 20)
 *   LOAD_CONCURRENCY       simultaneous virtual users     (default 32)
 *   LOAD_WALLETS           wallets in the spread scenario (default 200)
 *   LOAD_INSTANCES         application processes          (default 3)
 */
import { cpus, totalmem, release } from 'node:os';
import type { Subprocess } from 'bun';
import { createTestOrm, sqlRunner, type Sql } from '../integration/support/database';

const DURATION_S = Number(process.env.LOAD_DURATION_SECONDS ?? 20);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 32);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const INSTANCES = Number(process.env.LOAD_INSTANCES ?? 3);
const DATABASE_URL =
  process.env.LOAD_DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5432/wallet_load';
const BASE_PORT = 3700;
const suffix = Date.now().toString(36);

const instances: Subprocess[] = [];
const baseUrl = (i: number) => `http://localhost:${BASE_PORT + i}`;
let sequence = 0;
const unique = (prefix: string) => `${prefix}-${suffix}-${++sequence}`;

// ------------------------------------------------------------------ helpers

async function until(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function startInstances(): Promise<void> {
  for (let i = 0; i < INSTANCES; i += 1) {
    instances.push(
      Bun.spawn(['bun', 'run', 'src/main.ts'], {
        env: {
          ...process.env,
          PORT: String(BASE_PORT + i),
          DATABASE_URL,
          LOG_LEVEL: 'error',
          AUTH_ENABLED: 'false',
          SQS_TRANSACTIONS_QUEUE: `load-wager-transactions-${suffix}.fifo`,
          SQS_DLQ: `load-wager-transactions-dlq-${suffix}.fifo`,
          SQS_EVENTS_QUEUE: `load-wallet-events-${suffix}.fifo`,
        },
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    );
  }
  await Promise.all(
    instances.map((_, i) =>
      until(
        async () => (await fetch(`${baseUrl(i)}/health/ready`).catch(() => null))?.status === 200,
        30_000,
        `instance ${i} to be ready`,
      ),
    ),
  );
}

async function createWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = unique('player');
  const res = await fetch(`${baseUrl(0)}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`Could not create wallet: ${res.status} ${await res.text()}`);
  return { walletId: ((await res.json()) as { id: string }).id, playerId };
}

/** Sum of a counter across all instances, read from GET /metrics. */
async function metricSum(name: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < instances.length; i += 1) {
    const text = await (await fetch(`${baseUrl(i)}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(name) && !line.startsWith(`${name}_`)) total += Number(line.split(' ').pop());
    }
  }
  return total;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

// ----------------------------------------------------------------- scenario

type Target = { walletId: string; playerId: string };

interface ScenarioResult {
  name: string;
  description: string;
  requests: number;
  seconds: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  errors: number;
  errorRate: number;
  replays: number;
  lockConflicts: number;
  insertRaces: number;
  outboxPeakPending: number;
  outboxPeakLagSeconds: number;
  outboxDrainSeconds: number;
}

async function runScenario(
  sql: Sql,
  name: string,
  description: string,
  targets: Target[],
  replayRatio: number,
): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let errors = 0;
  let replays = 0;
  const sent: { url: string; init: RequestInit }[] = [];

  const lockBefore = await metricSum('wager_lock_conflicts_total');
  const raceBefore = await metricSum('wager_lock_conflicts_total{kind="insert_race"}');

  // Outbox sampler: how far behind the publishers get while requests arrive.
  let sampling = true;
  let peakPending = 0;
  let peakLag = 0;
  const outboxStats = async () => {
    const [row] = await sql(
      `select count(*)::int as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
         from outbox_messages where published_at is null`,
    );
    return { pending: row.pending as number, lag: Number(row.lag) };
  };
  const sampler = (async () => {
    while (sampling) {
      const { pending, lag } = await outboxStats();
      peakPending = Math.max(peakPending, pending);
      peakLag = Math.max(peakLag, lag);
      await Bun.sleep(250);
    }
  })();

  const startedAt = performance.now();
  const deadline = startedAt + DURATION_S * 1000;

  const user = async (id: number) => {
    while (performance.now() < deadline) {
      let request: { url: string; init: RequestInit };
      const replay = sent.length > 0 && Math.random() < replayRatio;
      if (replay) {
        request = sent[Math.floor(Math.random() * sent.length)];
      } else {
        const target = targets[Math.floor(Math.random() * targets.length)];
        const externalTransactionId = unique('ext');
        const kind = Math.random() < 0.6 ? 'BET' : 'WIN';
        request = {
          url: `${baseUrl((id + sequence) % instances.length)}/wagering/transactions`,
          init: {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `provider-a:${externalTransactionId}`,
            },
            body: JSON.stringify({
              providerId: 'provider-a',
              externalTransactionId,
              playerId: target.playerId,
              walletId: target.walletId,
              roundId: 'round-load',
              gameId: 'fortune-chimp',
              kind,
              money: { amount: '1.00', currency: 'BRL' },
            }),
          },
        };
        if (sent.length < 5_000) sent.push(request);
      }
      const t0 = performance.now();
      try {
        const res = await fetch(request.url, request.init);
        const body = (await res.json()) as { idempotentReplay?: boolean };
        latencies.push(performance.now() - t0);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (body.idempotentReplay) replays += 1;
        if (res.status >= 500) errors += 1;
      } catch {
        latencies.push(performance.now() - t0);
        statuses.network = (statuses.network ?? 0) + 1;
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => user(id)));
  const seconds = (performance.now() - startedAt) / 1000;

  // After the load stops: how long until every committed event is published.
  const drainStart = performance.now();
  await until(async () => (await outboxStats()).pending === 0, 300_000, 'the outbox to drain');
  const outboxDrainSeconds = (performance.now() - drainStart) / 1000;
  sampling = false;
  await sampler;

  latencies.sort((a, b) => a - b);
  const requests = latencies.length;
  return {
    name,
    description,
    requests,
    seconds,
    throughput: requests / seconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
    statuses,
    errors,
    errorRate: requests ? errors / requests : 0,
    replays,
    lockConflicts: (await metricSum('wager_lock_conflicts_total')) - lockBefore,
    insertRaces: (await metricSum('wager_lock_conflicts_total{kind="insert_race"}')) - raceBefore,
    outboxPeakPending: peakPending,
    outboxPeakLagSeconds: peakLag,
    outboxDrainSeconds,
  };
}

// ------------------------------------------------------------------- report

const ms = (value: number) => `${value.toFixed(1)} ms`;

function report(results: ScenarioResult[], environment: Record<string, string>, checks: Record<string, string>): string {
  const lines: string[] = [];
  lines.push('## Environment', '', '| Item | Value |', '| --- | --- |');
  for (const [k, v] of Object.entries(environment)) lines.push(`| ${k} | ${v} |`);
  lines.push('', '## Results', '');
  const row = (label: string, pick: (r: ScenarioResult) => string) =>
    `| ${label} | ${results.map(pick).join(' | ')} |`;
  lines.push(`| Metric | ${results.map((r) => r.name).join(' | ')} |`);
  lines.push(`| --- | ${results.map(() => '---').join(' | ')} |`);
  lines.push(row('Requests', (r) => String(r.requests)));
  lines.push(row('Duration', (r) => `${r.seconds.toFixed(1)} s`));
  lines.push(row('Throughput', (r) => `${r.throughput.toFixed(0)} req/s`));
  lines.push(row('Latency p50', (r) => ms(r.p50)));
  lines.push(row('Latency p95', (r) => ms(r.p95)));
  lines.push(row('Latency p99', (r) => ms(r.p99)));
  lines.push(row('Latency max', (r) => ms(r.max)));
  lines.push(row('HTTP statuses', (r) => Object.entries(r.statuses).map(([s, n]) => `${s}: ${n}`).join(', ')));
  lines.push(row('Errors (5xx + network)', (r) => `${r.errors} (${(r.errorRate * 100).toFixed(2)}%)`));
  lines.push(row('Idempotent replays', (r) => String(r.replays)));
  lines.push(row('Lock conflicts (timeouts, deadlocks, insert races)', (r) => String(r.lockConflicts)));
  lines.push(row('  of which insert races', (r) => String(r.insertRaces)));
  lines.push(row('Outbox peak pending', (r) => `${r.outboxPeakPending} events`));
  lines.push(row('Outbox peak lag', (r) => `${r.outboxPeakLagSeconds.toFixed(1)} s`));
  lines.push(row('Outbox drain after load', (r) => `${r.outboxDrainSeconds.toFixed(1)} s`));
  lines.push('', '## Scenarios', '');
  for (const r of results) lines.push(`- **${r.name}**: ${r.description}`);
  lines.push('', '## Consistency after the run', '', '| Check | Result |', '| --- | --- |');
  for (const [k, v] of Object.entries(checks)) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  console.error(`Preparing database and ${INSTANCES} instances...`);
  const orm = await createTestOrm(DATABASE_URL);
  const sql = sqlRunner(orm);
  try {
    await startInstances();

    console.error(`Creating ${WALLETS} wallets...`);
    const spread: Target[] = [];
    for (let i = 0; i < WALLETS; i += 20) {
      spread.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('1000000.00')))));
    }
    const hot = [await createWallet('1000000.00')];
    await until(
      async () => ((await sql(`select count(*)::int as n from outbox_messages where published_at is null`))[0].n as number) === 0,
      120_000,
      'setup events to be published',
    );

    const results: ScenarioResult[] = [];
    console.error(`Scenario 1/2: spread (${DURATION_S}s)...`);
    results.push(
      await runScenario(
        sql,
        'Spread',
        `${CONCURRENCY} virtual users, ${WALLETS} wallets chosen at random, 60% BET and 40% WIN of 1.00, 10% of requests are replays of an earlier request.`,
        spread,
        0.1,
      ),
    );
    console.error(`Scenario 2/2: hot wallet (${DURATION_S}s)...`);
    results.push(
      await runScenario(
        sql,
        'Hot wallet',
        `${CONCURRENCY} virtual users all on ONE wallet (worst case for the per-wallet lock), same mix, no replays.`,
        hot,
        0,
      ),
    );

    const [pg] = await sql(`select version() as v`);
    const [consistency] = await sql(
      `select count(*)::int as broken from (
         select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
          group by w.id
         having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)
       ) x`,
    );
    const [negatives] = await sql(`select count(*)::int as n from wallets where balance < 0`);
    const [duplicates] = await sql(
      `select count(*)::int as n from (select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1) x`,
    );
    const [totals] = await sql(
      `select (select count(*)::int from wager_transactions) as transactions,
              (select count(*)::int from wallet_ledger_entries) as entries,
              (select count(*)::int from outbox_messages) as events`,
    );

    const cpu = cpus();
    const output = report(
      results,
      {
        Date: new Date().toISOString(),
        CPU: `${cpu[0]?.model ?? 'unknown'} (${cpu.length} logical cores)`,
        Memory: `${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
        OS: `${process.platform} ${release()}`,
        Bun: Bun.version,
        PostgreSQL: String(pg.v).split(' on ')[0],
        'Application instances': `${INSTANCES} processes on the same machine as the load generator and the database`,
        'Virtual users': String(CONCURRENCY),
        'Duration per scenario': `${DURATION_S} s`,
      },
      {
        'Wallets whose balance differs from the ledger': String(consistency.broken),
        'Wallets with negative balance': String(negatives.n),
        'Transactions with more than one ledger entry': String(duplicates.n),
        'Rows written': `${totals.transactions} transactions, ${totals.entries} ledger entries, ${totals.events} events`,
      },
    );
    console.log(output);
    await Bun.write('load-test-results.md', `${output}\n`);
    console.error('\nSaved to load-test-results.md');
    if (consistency.broken !== 0 || negatives.n !== 0 || duplicates.n !== 0) process.exitCode = 1;
  } finally {
    for (const child of instances) child.kill('SIGTERM');
    await Promise.all(instances.map((child) => Promise.race([child.exited, Bun.sleep(5_000)])));
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  for (const child of instances) child.kill('SIGKILL');
  process.exit(1);
});
