import { CurrencyMismatchError, InsufficientFundsError, InvalidAmountError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when initialBalance is greater than zero. */
  opening?: { entryId: string; transactionId: string };
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance also produces
   * the CREDIT ledger entry of the internal OPENING transaction.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidAmountError('initial balance cannot be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) return { wallet };
    if (!props.opening) {
      throw new InvalidAmountError('a positive initial balance requires an opening transaction');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds a wallet already stored in the database, with no revalidation. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  /** The balance never changes without producing its ledger entry. */
  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    movement: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('movement amount must be greater than zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
