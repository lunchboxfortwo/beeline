import { expect, it } from 'vitest';
import { migratedDatabase } from './test-support.js';

// A transaction pooler drops the pools' startup `-c jit=off`; only a database
// default reaches pooled sessions.
it('defaults every session on the migrated database to no JIT', async () => {
  const database = await migratedDatabase();
  try {
    const { rows } = await database.query<{ setconfig: string[] }>(
      `SELECT setconfig FROM pg_db_role_setting
       WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    );
    expect(rows[0]?.setconfig).toContain('jit=off');
  } finally {
    await database.close();
  }
});
