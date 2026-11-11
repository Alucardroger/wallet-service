import { Injectable } from '@nestjs/common';
import { config } from '../shared/config';
import { Metrics } from '../shared/metrics';
import { EventPublisher, OutboxRepository, type RelayResult } from './ports';

/**
 * Publishes events stored in the outbox. Events are written in the same SQL
 * transaction as the financial change and only published afterwards, so an
 * event is never published before its commit and never lost after it.
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly metrics: Metrics,
  ) {}

  async publishBatch(limit = config.outbox.batchSize()): Promise<RelayResult> {
    const result = await this.outbox.relay(limit, (message) => this.publisher.publish(message));
    if (result.published) this.metrics.increment('wager_outbox_published_total', {}, result.published);
    if (result.failed) this.metrics.increment('wager_retries_total', { component: 'outbox' }, result.failed);
    return result;
  }

  /** Updates the outbox gauges (pending count and age of the oldest event). */
  async refreshLag(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const stats = await this.outbox.stats();
    this.metrics.gauge('wager_outbox_pending', stats.pending);
    this.metrics.gauge('wager_outbox_lag_seconds', Number(stats.oldestAgeSeconds.toFixed(3)));
    return stats;
  }
}
