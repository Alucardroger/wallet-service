/** Every setting comes from the environment, with defaults that match docker-compose.yml. */
const text = (name: string, fallback: string): string => process.env[name] ?? fallback;
const int = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};
const flag = (name: string, fallback: boolean): boolean =>
  (process.env[name] ?? String(fallback)).toLowerCase() !== 'false';

export const config = {
  port: () => int('PORT', 3000),
  logLevel: () => text('LOG_LEVEL', 'info'),
  sqs: {
    endpoint: () => text('SQS_ENDPOINT', 'http://localhost:4566'),
    region: () => text('AWS_REGION', 'us-east-1'),
    accessKeyId: () => text('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: () => text('AWS_SECRET_ACCESS_KEY', 'test'),
    transactionsQueue: () => text('SQS_TRANSACTIONS_QUEUE', 'wager-transactions.fifo'),
    deadLetterQueue: () => text('SQS_DLQ', 'wager-transactions-dlq.fifo'),
    eventsQueue: () => text('SQS_EVENTS_QUEUE', 'wallet-events.fifo'),
    /** The app creates its queues at startup. Turn off where queues are provisioned elsewhere. */
    createQueues: () => flag('SQS_CREATE_QUEUES', true),
  },
  consumer: {
    enabled: () => flag('CONSUMER_ENABLED', true),
    name: () => text('CONSUMER_NAME', 'wager-transactions-consumer'),
    /** Deliveries of one message before it is moved to the DLQ. */
    maxReceives: () => int('CONSUMER_MAX_RECEIVES', 5),
    waitSeconds: () => int('CONSUMER_WAIT_SECONDS', 5),
    visibilitySeconds: () => int('CONSUMER_VISIBILITY_SECONDS', 30),
    retryBaseSeconds: () => int('CONSUMER_RETRY_BASE_SECONDS', 2),
  },
  outbox: {
    enabled: () => flag('OUTBOX_PUBLISHER_ENABLED', true),
    batchSize: () => int('OUTBOX_BATCH_SIZE', 20),
    pollMs: () => int('OUTBOX_POLL_MS', 500),
  },
  pendingReference: {
    enabled: () => flag('PENDING_REFERENCE_WORKER_ENABLED', true),
    batchSize: () => int('PENDING_REFERENCE_BATCH_SIZE', 20),
    pollMs: () => int('PENDING_REFERENCE_POLL_MS', 1_000),
  },
};
