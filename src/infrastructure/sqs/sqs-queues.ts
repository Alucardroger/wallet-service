import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { config } from '../../shared/config';

/**
 * SQS client plus the addresses of the three queues. Queue URLs are resolved
 * on first use and cached, so the application starts even while SQS is down.
 */
@Injectable()
export class SqsQueues implements OnApplicationShutdown {
  readonly client = new SQSClient({
    endpoint: config.sqs.endpoint(),
    region: config.sqs.region(),
    credentials: {
      accessKeyId: config.sqs.accessKeyId(),
      secretAccessKey: config.sqs.secretAccessKey(),
    },
    maxAttempts: 2,
  });

  private readonly urls = new Map<string, Promise<string>>();

  transactionsUrl(): Promise<string> {
    return this.resolve(config.sqs.transactionsQueue(), async () => {
      const dlqArn = await this.arnOf(await this.deadLetterUrl());
      return {
        // Safety net only: the consumer moves a message to the DLQ itself when
        // it reaches the limit. This covers a consumer that keeps crashing.
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(config.consumer.maxReceives() + 2),
        }),
      };
    });
  }

  deadLetterUrl(): Promise<string> {
    return this.resolve(config.sqs.deadLetterQueue());
  }

  eventsUrl(): Promise<string> {
    return this.resolve(config.sqs.eventsQueue());
  }

  /** Throws when SQS cannot be reached. Used by the readiness check. */
  async ping(): Promise<void> {
    await this.arnOf(await this.transactionsUrl());
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private resolve(name: string, extraAttributes?: () => Promise<Record<string, string>>): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const pending = this.lookup(name, extraAttributes).catch((error) => {
      this.urls.delete(name); // try again on the next call
      throw error;
    });
    this.urls.set(name, pending);
    return pending;
  }

  private async lookup(name: string, extraAttributes?: () => Promise<Record<string, string>>): Promise<string> {
    if (!config.sqs.createQueues()) {
      const found = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      return found.QueueUrl as string;
    }
    // CreateQueue returns the existing queue when it is already there.
    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ...(extraAttributes ? await extraAttributes() : {}) },
      }),
    );
    return created.QueueUrl as string;
  }

  private async arnOf(queueUrl: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    return result.Attributes?.QueueArn as string;
  }
}
