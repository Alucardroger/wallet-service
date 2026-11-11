import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

const HELP: Record<string, string> = {
  wager_transactions_total: 'Transactions that reached a result, by kind and status',
  wager_duplicates_total: 'Duplicates detected (idempotent replays and repeated queue messages), by source',
  wager_idempotency_conflicts_total: 'Requests refused because the key was reused with another payload',
  wager_retries_total: 'Retries, by component',
  wager_dlq_messages_total: 'Messages moved to the dead-letter queue, by reason',
  wager_lock_conflicts_total: 'Lock timeouts, deadlocks and lost insert races, by kind',
  wager_processing_duration_seconds: 'Time to process one transaction, by source',
  wager_outbox_published_total: 'Outbox events published',
  wager_outbox_pending: 'Outbox events not yet published',
  wager_outbox_lag_seconds: 'Age of the oldest unpublished outbox event',
  wager_reconciliation_mismatches_total: 'Reconciliations where the balance differed from the ledger',
};

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const key = (name: string, labels: Labels): string => {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

/**
 * Small in-process metrics registry, exposed in Prometheus text format at
 * GET /metrics. Values are per instance; a scraper adds the instances up.
 */
@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();

  increment(name: string, labels: Labels = {}, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(key(name, labels), value);
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    const k = key(name, labels);
    const h = this.histograms.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((limit, i) => {
      if (seconds <= limit) h.buckets[i] += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.histograms.set(k, h);
  }

  /** For tests and diagnostics. */
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const header = (series: string, type: string) => {
      const name = series.split('{')[0];
      const marker = `# TYPE ${name} ${type}`;
      if (!lines.includes(marker)) {
        lines.push(`# HELP ${name} ${HELP[name] ?? name}`, marker);
      }
    };
    for (const [series, value] of [...this.counters].sort()) {
      header(series, 'counter');
      lines.push(`${series} ${value}`);
    }
    for (const [series, value] of [...this.gauges].sort()) {
      header(series, 'gauge');
      lines.push(`${series} ${value}`);
    }
    for (const [series, h] of [...this.histograms].sort()) {
      header(series, 'histogram');
      const [name, rest] = series.split('{');
      const labels = rest ? `${rest.slice(0, -1)},` : '';
      BUCKETS.forEach((limit, i) => lines.push(`${name}_bucket{${labels}le="${limit}"} ${h.buckets[i]}`));
      lines.push(`${name}_bucket{${labels}le="+Inf"} ${h.count}`);
      lines.push(`${name}_sum${rest ? `{${rest}` : ''} ${h.sum}`);
      lines.push(`${name}_count${rest ? `{${rest}` : ''} ${h.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
