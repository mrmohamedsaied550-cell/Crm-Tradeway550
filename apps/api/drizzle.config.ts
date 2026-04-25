import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/*',
  out: './src/db/migrations',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://crm_user:crm_dev_pass_2026@localhost:3306/crm_tradeway',
  },
  verbose: true,
  strict: true,
});
