import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './orm.config';

/** Usage: bun run src/infrastructure/database/migrate.ts up | down | status */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(createOrmConfig());
  try {
    if (command === 'up') {
      const applied = await orm.migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
    } else if (command === 'down') {
      const reverted = await orm.migrator.down();
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
    } else if (command === 'status') {
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log(`Executed: ${executed.map((m) => m.name).join(', ') || '(none)'}`);
      console.log(`Pending: ${pending.map((m) => m.name).join(', ') || '(none)'}`);
    } else {
      throw new Error(`Unknown command "${command}". Use up, down or status.`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
