import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { IdempotencyConflictError, ValidationError } from '../../application/errors';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { parseQueueMessage } from '../../application/validation';
import { DomainError } from '../../domain/errors';
import { config } from '../../shared/config';
import { JsonLogger, describeError } from '../../shared/logger';
import { Metrics } from '../../shared/metrics';
import { SqsQueues } from './sqs-queues';

export interface PollOptions {
  waitSeconds?: number;
  /** When it turns true, messages not started yet are handed back to the queue. */
  shouldStop?: () => boolean;
  abortSignal?: AbortSignal;
}

/**
 * Consumes wager-transactions.fifo and calls the same use case as the HTTP entry.
 *
 * Outcome of each message:
 *   - handled, including business rejections -> acknowledged AFTER the commit
 *   - invalid message or idempotency conflict -> permanent: moved to the DLQ
 *   - any other failure -> transient: left in the queue with a growing delay,
 *     and moved to the DLQ once it has been delivered `maxReceives` times
 */
@Injectable()
export class WagerTransactionsConsumer {
  private readonly logger = new JsonLogger(WagerTransactionsConsumer.name);

  constructor(
    private readonly queues: SqsQueues,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly metrics: Metrics,
  ) {}

  /** Receives one batch and handles it. Returns how many messages were received. */
  async pollOnce(options: PollOptions = {}): Promise<number> {
    const queueUrl = await this.queues.transactionsUrl();
    const received = await this.queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: options.waitSeconds ?? config.consumer.waitSeconds(),
        VisibilityTimeout: config.consumer.visibilitySeconds(),
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: options.abortSignal },
    );
    const messages = received.Messages ?? [];
    for (const message of messages) {
      if (options.shouldStop?.()) {
        // Shutting down: give the message back right away for another instance.
        await this.setVisibility(queueUrl, message, 0);
      } else {
        await this.handle(queueUrl, message);
      }
    }
    return messages.length;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let messageId: string | undefined;
    try {
      const parsed = parseQueueMessage(message.Body);
      messageId = parsed.messageId;
      await this.useCase.submit(parsed.command, {
        consumerName: config.consumer.name(),
        messageId: parsed.messageId,
      });
      // The database transaction is committed: only now is the message removed.
      await this.acknowledge(queueUrl, message);
    } catch (error) {
      const fields = { messageId, sqsMessageId: message.MessageId, receiveCount, ...describeError(error) };
      if (isPermanent(error)) {
        this.logger.warn('message cannot be processed, moving to DLQ', fields);
        await this.moveToDeadLetter(queueUrl, message, (error as { code?: string }).code ?? 'PERMANENT');
      } else if (receiveCount >= config.consumer.maxReceives()) {
        this.logger.error('message failed too many times, moving to DLQ', fields);
        await this.moveToDeadLetter(queueUrl, message, 'MAX_RECEIVES_EXCEEDED');
      } else {
        const delay = Math.min(config.consumer.retryBaseSeconds() * 2 ** (receiveCount - 1), 300);
        this.logger.warn('message failed, will be retried', { ...fields, retryInSeconds: delay });
        this.metrics.increment('wager_retries_total', { component: 'consumer' });
        await this.setVisibility(queueUrl, message, delay);
      }
    }
  }

  private async acknowledge(queueUrl: string, message: Message): Promise<void> {
    await this.queues.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async setVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.queues.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // Not fatal: the message becomes visible again when its timeout ends.
      this.logger.warn('could not change message visibility', describeError(error));
    }
  }

  private async moveToDeadLetter(queueUrl: string, message: Message, reason: string): Promise<void> {
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.deadLetterUrl(),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.acknowledge(queueUrl, message);
    this.metrics.increment('wager_dlq_messages_total', { reason });
  }
}

/** Errors that sending the same message again can never fix. */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DomainError
  );
}
