import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { env } from '../lib/env.js';
import * as schema from './schema/index.js';

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: 10,
  waitForConnections: true,
  enableKeepAlive: true,
});

export const db = drizzle(pool, { schema, mode: 'default' });

export type Db = typeof db;
