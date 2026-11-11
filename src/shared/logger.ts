import type { LoggerService } from '@nestjs/common';
import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const WEIGHT: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Fields allowed in a log line. Identifiers only: no amounts, balances or
 * full payloads, so logs never carry financial data.
 */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/** One JSON object per line on stdout. */
export class JsonLogger {
  constructor(private readonly context: string) {}

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: Level, message: string, fields: LogFields): void {
    if (WEIGHT[level] < (WEIGHT[config.logLevel()] ?? WEIGHT.info)) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...fields,
    });
    if (level === 'error') console.error(line);
    else console.log(line);
  }
}

export const describeError = (error: unknown): { errorName: string; errorMessage: string } =>
  error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: 'Unknown', errorMessage: String(error) };

/** Makes NestJS's own messages (startup, routes) come out as JSON too. */
export class NestJsonLogger implements LoggerService {
  private readonly logger = new JsonLogger('nest');

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { nestContext: context });
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { nestContext: context });
  }
  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error(String(message), { nestContext: context, stack });
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug(String(message), { nestContext: context });
  }
  verbose(message: unknown, context?: string): void {
    this.logger.debug(String(message), { nestContext: context });
  }
}
