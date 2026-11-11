export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super('CURRENCY_MISMATCH', `Expected currency ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient for this debit');
  }
}

export class InvalidAmountError extends DomainError {
  constructor(message: string) {
    super('INVALID_AMOUNT', message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}
