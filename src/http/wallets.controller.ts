import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../application/errors';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import { WalletQueries } from '../application/ports';
import { correlationIdOf } from './correlation';
import { ProviderAuthGuard } from './provider-auth.guard';
import { decodeCursor, encodeCursor, parseLimit, parseOpenWallet, parseUuid } from './validation';
import { ledgerEntryView, walletView } from './views';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const wallet = await this.openWallet.execute(parseOpenWallet(body, correlationIdOf(req, res)));
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.findWallet(parseUuid(walletId, 'walletId'));
    if (!wallet) throw new NotFoundError('Wallet');
    return walletView(wallet);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const id = parseUuid(walletId, 'walletId');
    const pageSize = parseLimit(limit);
    const after = decodeCursor(cursor);
    if (!(await this.queries.findWallet(id))) throw new NotFoundError('Wallet');

    // One extra row tells whether there is a next page.
    const rows = await this.queries.ledgerPage(id, after, pageSize + 1);
    const items = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    return {
      items: items.map(ledgerEntryView),
      nextCursor: hasMore ? encodeCursor(items[items.length - 1].seq) : null,
    };
  }
}
