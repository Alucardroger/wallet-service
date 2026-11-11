import { Injectable } from '@nestjs/common';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { newId } from '../shared/ids';
import { UniqueViolationError, WalletAlreadyExistsError } from './errors';
import { computePayloadHash } from './payload-hash';
import { UnitOfWork } from './ports';

export const INTERNAL_PROVIDER_ID = 'internal';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const now = new Date();
    const walletId = newId();
    const openingTransactionId = newId();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      opening: { entryId: newId(), transactionId: openingTransactionId },
    });

    try {
      await this.uow.run(async (store) => {
        await store.insertWallet(wallet);
        if (!openingEntry) return;

        // A positive initial balance is an internal OPENING transaction with its
        // CREDIT ledger entry, in the same SQL transaction as the wallet.
        const externalId = `opening:${walletId}`;
        const opening = WagerTransaction.create({
          id: openingTransactionId,
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: externalId,
          idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalId}`,
          payloadHash: computePayloadHash({
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: externalId,
            playerId: command.playerId,
            walletId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initialBalance.toJSON(),
          }),
          walletId,
          playerId: command.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt: now,
        });
        opening.markProcessed(undefined, wallet.balance, now);
        await store.insertTransaction(opening, command.correlationId);
        await store.insertLedgerEntry(openingEntry);

        const ctx = () => ({
          eventId: newId(),
          correlationId: command.correlationId,
          causationId: opening.id,
          occurredAt: now,
        });
        await store.enqueueOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())));
        await store.enqueueOutbox(
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())),
        );
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_uq') {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
    return wallet;
  }
}
