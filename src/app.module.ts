import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { UnitOfWork, WalletQueries } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { MikroOrmUnitOfWork, MikroOrmWalletQueries } from './infrastructure/database/mikro-orm.adapter';
import { createOrmConfig } from './infrastructure/database/orm.config';

/** Closes the connection pool when the application stops. */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    // The application layer depends on these ports; MikroORM is one implementation.
    { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
    { provide: WalletQueries, useClass: MikroOrmWalletQueries },
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    DatabaseLifecycle,
  ],
})
export class AppModule {}
