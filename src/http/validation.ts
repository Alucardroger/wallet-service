import { ValidationError } from '../application/errors';
import type { OpenWalletCommand } from '../application/open-wallet.use-case';
import type { SubmitTransactionCommand } from '../application/process-wager-transaction.use-case';
import type { MoneyProps } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

type Json = Record<string, unknown>;

function asObject(value: unknown, name: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be a JSON object`);
  }
  return value as Json;
}

function identifier(body: Json, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ValidationError(`${field} must be 1-128 characters: letters, digits, ".", "_", ":" or "-"`);
  }
  return value;
}

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

/** Shape only. The amount and currency rules are enforced by Money.from. */
function money(body: Json, field: string): MoneyProps {
  const value = asObject(body[field], field);
  if (typeof value.amount !== 'string' || typeof value.currency !== 'string') {
    throw new ValidationError(`${field} must be { "amount": "25.00", "currency": "BRL" } with string values`);
  }
  return { amount: value.amount, currency: value.currency };
}

export function parseOpenWallet(body: unknown, correlationId: string): OpenWalletCommand {
  const json = asObject(body, 'body');
  return {
    playerId: identifier(json, 'playerId'),
    initialBalance: money(json, 'initialBalance'),
    correlationId,
  };
}

/** Used by HTTP (key from the header) and by the queue consumer (key from the message). */
export function parseSubmitTransaction(
  body: unknown,
  idempotencyKey: unknown,
  correlationId: string,
): SubmitTransactionCommand {
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new ValidationError('Idempotency-Key is required (1-255 printable characters, no spaces)');
  }
  const json = asObject(body, 'body');
  const kind = json.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.has(kind)) {
    throw new ValidationError('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
  }
  const reference = json.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null) identifier(json, 'referenceExternalTransactionId');
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    throw new ValidationError(`${kind} requires referenceExternalTransactionId`);
  }
  return {
    providerId: identifier(json, 'providerId'),
    externalTransactionId: identifier(json, 'externalTransactionId'),
    idempotencyKey,
    playerId: identifier(json, 'playerId'),
    walletId: parseUuid(json.walletId, 'walletId'),
    roundId: identifier(json, 'roundId'),
    gameId: identifier(json, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money(json, 'money'),
    ...(reference ? { referenceExternalTransactionId: reference as string } : {}),
    correlationId,
  };
}

export function parseLimit(value: unknown, fallback = 50, max = 200): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

// The cursor is opaque to clients: base64url of "v1:<ledger position>".
export function encodeCursor(seq: string): string {
  return Buffer.from(`v1:${seq}`).toString('base64url');
}

export function decodeCursor(value: unknown): string | null {
  if (value === undefined) return null;
  const decoded = typeof value === 'string' ? Buffer.from(value, 'base64url').toString() : '';
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match) throw new ValidationError('cursor is invalid');
  return match[1];
}
