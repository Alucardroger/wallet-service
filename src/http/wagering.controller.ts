import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../application/errors';
import { WalletQueries } from '../application/ports';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { correlationIdOf } from './correlation';
import { ProviderAuthGuard, assertCanSeeProvider } from './provider-auth.guard';
import { parseSubmitTransaction, parseUuid } from '../application/validation';
import { transactionView } from './views';

/**
 * The status code depends only on the state of the transaction, so a replay
 * always gets the same code as the original answer:
 *   200 PROCESSED          applied
 *   202 PENDING_REFERENCE  accepted, waiting for the referenced transaction
 *   422 REJECTED / FAILED  refused by a business rule (see failureCode)
 */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 422,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseSubmitTransaction(body, idempotencyKey, correlationIdOf(req, res));
    const result = await this.processTransaction.submit(command);
    res.status(STATUS_CODE[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string, @Req() req: Request) {
    const tx = await this.queries.findTransaction(parseUuid(transactionId, 'transactionId'));
    if (!tx) throw new NotFoundError('Transaction');
    assertCanSeeProvider(req, tx.providerId);
    return transactionView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.queries.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) throw new NotFoundError('Transaction');
    return transactionView(tx);
  }
}
