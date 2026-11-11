import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './http/http-error.filter';
import { config } from './shared/config';
import { NestJsonLogger } from './shared/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: new NestJsonLogger() });
  app.useGlobalFilters(new HttpErrorFilter());
  // SIGTERM/SIGINT: stop the workers, finish what is in progress, close connections.
  app.enableShutdownHooks();
  await app.listen(config.port());
}

void bootstrap();
