import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { OutboxPublisher } from './application/outbox-publisher';
import { PendingReferenceRetrier } from './application/pending-reference-retrier';
import { EventPublisher, OutboxRepository, UnitOfWork, WalletQueries } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { HealthController, ReconciliationController } from './http/operations.controller';
import { TokenVerifier } from './http/token-verifier';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { BackgroundWorkers } from './infrastructure/background-workers';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWalletQueries,
} from './infrastructure/database/mikro-orm.adapter';
import { createOrmConfig } from './infrastructure/database/orm.config';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { SqsQueues } from './infrastructure/sqs/sqs-queues';
import { WagerTransactionsConsumer } from './infrastructure/sqs/wager-transactions.consumer';
import { Metrics } from './shared/metrics';

/** Closes the connection pool when the application stops (after the workers have stopped). */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [WalletsController, WageringController, ReconciliationController, HealthController],
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    // The application layer depends on these ports; MikroORM and SQS are the implementations.
    { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
    { provide: WalletQueries, useClass: MikroOrmWalletQueries },
    { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
    { provide: EventPublisher, useClass: SqsEventPublisher },
    Metrics,
    TokenVerifier,
    SqsQueues,
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    OutboxPublisher,
    PendingReferenceRetrier,
    WagerTransactionsConsumer,
    BackgroundWorkers,
    DatabaseLifecycle,
  ],
})
export class AppModule {}
