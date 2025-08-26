import { config } from 'dotenv';
config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });

export const CREDENTIALS = process.env.CREDENTIALS === 'true';
export const { NODE_ENV, PORT, SECRET_KEY, LOG_FORMAT, LOG_DIR, ORIGIN } = process.env;
export const { DB_HOST, DB_PORT, DB_DATABASE } = process.env;
export const { GOOGLE_API_KEY } = process.env;
export const GOOGLE_MODEL = process.env.GOOGLE_MODEL || 'gemini-1.5-flash';
export const SCHEMA_REGISTRY_TTL_MS = Number(process.env.SCHEMA_REGISTRY_TTL_MS || 24 * 60 * 60 * 1000);
export const DEFAULT_ROW_LIMIT = Number(process.env.DEFAULT_ROW_LIMIT || 1000);
export const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS || 15000);
export const REDACT_SQL_IN_RESPONSES = String(process.env.REDACT_SQL_IN_RESPONSES || 'false') === 'true';
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX || 10);
export const MYSQL_POOL_CONNECTION_LIMIT = Number(process.env.MYSQL_POOL_CONNECTION_LIMIT || 10);
