import { Controller, Get, Header, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OutboxPublisher } from '../application/outbox-publisher';
import { WalletQueries } from '../application/ports';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import { parseUuid } from '../application/validation';
import { SqsQueues } from '../infrastructure/sqs/sqs-queues';
import { describeError } from '../shared/logger';
import { Metrics } from '../shared/metrics';
import { correlationIdOf } from './correlation';
import { ProviderAuthGuard } from './provider-auth.guard';

/** Health checks and metrics: open endpoints, no authentication. */
@Controller()
export class HealthController {
  constructor(
    private readonly queries: WalletQueries,
    private readonly queues: SqsQueues,
    private readonly outbox: OutboxPublisher,
    private readonly metrics: Metrics,
  ) {}

  /** Liveness: the process is up. Does not touch any dependency. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS can be reached, so this instance can take traffic. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = async (probe: () => Promise<void>) => {
      try {
        await probe();
        return { status: 'up' };
      } catch (error) {
        return { status: 'down', error: describeError(error).errorName };
      }
    };
    const [postgres, sqs] = await Promise.all([
      check(() => this.queries.ping()),
      check(() => this.queues.ping()),
    ]);
    const ready = postgres.status === 'up' && sqs.status === 'up';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsText() {
    await this.outbox.refreshLag().catch(() => undefined); // metrics stay readable while the database is down
    return this.metrics.render();
  }
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class ReconciliationController {
  constructor(private readonly reconcile: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  run(@Param('walletId') walletId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.reconcile.execute(parseUuid(walletId, 'walletId'), correlationIdOf(req, res));
  }
}
