import { Injectable } from '@nestjs/common';
import { config } from '../shared/config';
import { JsonLogger, describeError } from '../shared/logger';
import { WalletQueries } from './ports';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

/** Retries REFUND/ROLLBACK transactions that are waiting for their reference. */
@Injectable()
export class PendingReferenceRetrier {
  private readonly logger = new JsonLogger(PendingReferenceRetrier.name);

  constructor(
    private readonly queries: WalletQueries,
    private readonly useCase: ProcessWagerTransactionUseCase,
  ) {}

  /** Returns how many due transactions were found. Safe to run on several instances. */
  async runOnce(limit = config.pendingReference.batchSize(), now = new Date()): Promise<number> {
    const due = await this.queries.duePendingReferences(now, limit);
    for (const transactionId of due) {
      try {
        await this.useCase.retryPendingReference(transactionId, `pending-reference:${transactionId}`);
      } catch (error) {
        // One failure does not stop the others; this one is picked up again later.
        this.logger.warn('pending reference retry failed', { transactionId, ...describeError(error) });
      }
    }
    return due.length;
  }
}
