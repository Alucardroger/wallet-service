import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../domain/money';
import { JsonLogger } from '../shared/logger';
import { Metrics } from '../shared/metrics';
import { NotFoundError } from './errors';
import { WalletQueries } from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Compares the stored balance with the balance rebuilt from the ledger. Never fixes anything. */
@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new JsonLogger(ReconcileWalletUseCase.name);

  constructor(
    private readonly queries: WalletQueries,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) throw new NotFoundError('Wallet');
    const totals = await this.queries.ledgerTotals(walletId);
    const money = (amount: string) => Money.from({ amount, currency: wallet.currency });

    const calculated = money(totals.credits).subtract(money(totals.debits));
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      // A divergence is reported loudly and left for people to investigate.
      this.metrics.increment('wager_reconciliation_mismatches_total');
      this.logger.error('wallet balance differs from its ledger', {
        correlationId,
        walletId,
        checkedEntries: totals.entries,
      });
    }
    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: totals.entries,
    };
  }
}
