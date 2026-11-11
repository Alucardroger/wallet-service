import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { SqsQueues } from './sqs-queues';

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(private readonly queues: SqsQueues) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.eventsUrl(),
        MessageBody: JSON.stringify(message.payload),
        // Events of the same aggregate keep their order. The event id removes
        // duplicates inside SQS's 5-minute window; beyond it, consumers must
        // deduplicate by eventId, which is in the body.
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
