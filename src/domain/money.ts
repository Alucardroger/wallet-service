import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Own Decimal configuration: enough precision that sums never round.
const D = Decimal.clone({ precision: 40 });

// Exactly 2 decimal places, no sign, no exponent, up to 18 integer digits
// (fits the NUMERIC(20,2) column used in PostgreSQL).
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props?.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter ISO-4217 code');
    }
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    return new Money(new D(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    if (this.value.isZero()) return this;
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
