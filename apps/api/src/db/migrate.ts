import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

async function main() {
  const url = process.env.DATABASE_URL ?? 'mysql://crm_user:crm_dev_pass_2026@localhost:3306/crm_tradeway';
  const connection = await mysql.createConnection(url);
  const db = drizzle(connection);
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations complete.');
  await connection.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
