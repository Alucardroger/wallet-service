import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('parses and serializes with a fixed scale of 2', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.05').toString()).toBe('0.05 BRL');
    expect(Money.zero('BRL').toJSON().amount).toBe('0.00');
  });

  it.each([
    '', ' ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E-2', '25', '25.0',
    '25.000', '25.001', '-1.00', '+1.00', '1,00', '01.00', '.50', '1.', 'abc',
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejects non-string amounts and invalid currencies', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
  });

  it('adds and subtracts exactly, with no floating point error', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  it('keeps large values exact', () => {
    const big = brl('999999999999999999.99');
    expect(big.add(big).toJSON().amount).toBe('1999999999999999999.98');
  });

  it('can represent a negative result internally', () => {
    const diff = brl('10.00').subtract(brl('30.00'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.toJSON().amount).toBe('-20.00');
    expect(diff.negate().equals(brl('20.00'))).toBe(true);
  });

  it('never produces negative zero', () => {
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  it('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  it('compares values', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  it('throws a domain error when currencies differ', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});