import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://supernavi:supernavi@localhost:5432/supernavi'
    });
  }
  return pool;
}

export async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function runMigrations() {
  const migrationsDir = process.env.MIGRATIONS_DIR || '/app/db/migrations';
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const migrationName = file.replace('.sql', '');

    // Check if migration already applied
    try {
      const result = await query(
        'SELECT 1 FROM migrations WHERE name = $1',
        [migrationName]
      );

      if (result.rows.length > 0) {
        console.log(`Migration ${migrationName} already applied, skipping`);
        continue;
      }
    } catch (err) {
      // migrations table doesn't exist yet, will be created by first migration
    }

    console.log(`Applying migration: ${migrationName}`);
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    await query(sql);

    // Record migration
    await query(
      'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      [migrationName]
    );

    console.log(`Migration ${migrationName} applied successfully`);
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
