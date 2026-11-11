import { DomainError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `Cannot move transaction from ${from} to ${to}`);
  }
}

export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION', message);
  }
}

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** The id at the provider, not our internal id. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its result (for replays). */
  resultBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Valid transitions:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry)
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _resultBalance?: Money;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultBalance = state.resultBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /** Born PENDING. Validates the reference requirement by kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
    if (tx.requiresReference() && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.money.isNegative() || (tx.affectsBalance() && !props.money.isPositive())) {
      throw new InvalidTransactionError(`${props.kind} requires an amount greater than zero`);
    }
    return tx;
  }

  /** Rebuilds a transaction already stored in the database, with no revalidation. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionError(`${this.kind} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = balance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Reference not found yet: wait and count one more attempt. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.PendingReference);
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(`${this.kind} does not wait for a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, balance: Money | undefined, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    this.finish(WagerTransactionStatus.Rejected, code, balance, at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    this.finish(WagerTransactionStatus.Failed, code, undefined, at);
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        throw new InvalidTransactionError(`${this.kind} does not move the balance`);
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      resultBalance: this._resultBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
    };
  }

  private finish(
    status: WagerTransactionStatus,
    code: FailureCode,
    balance: Money | undefined,
    at: Date,
  ): void {
    this._status = status;
    this._failureCode = code;
    this._resultBalance = balance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  private assertCanMoveTo(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }
}
