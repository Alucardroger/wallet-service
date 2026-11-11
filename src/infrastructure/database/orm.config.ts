import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261111000001InitialSchema } from './migrations/Migration20261111000001InitialSchema';

export const DEFAULT_DATABASE_URL = 'postgresql://wallet:wallet@localhost:5432/wallet';

/** Explicit list: no file scanning, same behaviour in dev, tests and production. */
export const migrationsList = [Migration20261111000001InitialSchema];

export function createOrmConfig(clientUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}

export default createOrmConfig();
