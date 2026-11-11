import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/database/orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://wallet:wallet@localhost:5432/wallet_test';

/** Connects to a separate test database (created on demand) with a fresh schema. */
export async function createTestOrm(url = TEST_DATABASE_URL): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig(url));
  await orm.schema.ensureDatabase();
  await resetSchema(orm);
  return orm;
}

/** Drops everything and applies all migrations again. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute('drop schema public cascade; create schema public;');
  await orm.migrator.up();
}

export type Sql = (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export function sqlRunner(orm: MikroORM): Sql {
  return (query, params = []) => orm.em.getConnection().execute(query, params);
}
