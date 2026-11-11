import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { OutboxPublisher } from '../application/outbox-publisher';
import { PendingReferenceRetrier } from '../application/pending-reference-retrier';
import { config } from '../shared/config';
import { JsonLogger, describeError } from '../shared/logger';
import { WagerTransactionsConsumer } from './sqs/wager-transactions.consumer';

/**
 * Runs `step` again and again until stopped. `step` returns true when it did
 * some work (so the next round starts at once) or false to rest for `idleMs`.
 * A failing round is logged and retried after a pause that grows up to 10s.
 */
class Loop {
  private stopping = false;
  private running?: Promise<void>;
  private wake?: () => void;
  readonly abort = new AbortController();

  constructor(
    private readonly name: string,
    private readonly idleMs: number,
    private readonly step: (loop: Loop) => Promise<boolean>,
    private readonly logger: JsonLogger,
  ) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  start(): void {
    this.running = this.run();
  }

  /** Lets the round in progress finish, then resolves. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    this.wake?.();
    await this.running;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        const worked = await this.step(this);
        failures = 0;
        if (!worked) await this.sleep(this.idleMs);
      } catch (error) {
        if (this.stopping) break;
        failures += 1;
        this.logger.warn(`${this.name} round failed`, { failures, ...describeError(error) });
        await this.sleep(Math.min(500 * 2 ** failures, 10_000));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/** Starts the background loops with the application and stops them cleanly on SIGTERM. */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new JsonLogger(BackgroundWorkers.name);
  private readonly loops: Loop[] = [];

  constructor(
    private readonly consumer: WagerTransactionsConsumer,
    private readonly outbox: OutboxPublisher,
    private readonly pendingReferences: PendingReferenceRetrier,
  ) {}

  onApplicationBootstrap(): void {
    if (config.consumer.enabled()) {
      this.add('sqs-consumer', 0, async (loop) => {
        await this.consumer.pollOnce({ shouldStop: () => loop.isStopping, abortSignal: loop.abort.signal });
        return true; // long polling already waits when the queue is empty
      });
    }
    if (config.outbox.enabled()) {
      this.add('outbox-publisher', config.outbox.pollMs(), async () => {
        const { published, failed } = await this.outbox.publishBatch();
        return published > 0 && failed === 0;
      });
    }
    if (config.pendingReference.enabled()) {
      this.add('pending-reference-retrier', config.pendingReference.pollMs(), async () => {
        await this.pendingReferences.runOnce();
        return false;
      });
    }
    for (const loop of this.loops) loop.start();
  }

  /**
   * Runs before the database and SQS connections are closed: stop taking new
   * work, let messages in progress finish, hand the rest back to the queue.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.loops.length) return;
    this.logger.info('stopping background workers', { signal });
    await Promise.all(this.loops.map((loop) => loop.stop()));
    this.logger.info('background workers stopped');
  }

  private add(name: string, idleMs: number, step: (loop: Loop) => Promise<boolean>): void {
    this.loops.push(new Loop(name, idleMs, step, this.logger));
  }
}
