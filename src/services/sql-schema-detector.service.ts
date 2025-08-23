import { Service } from 'typedi';
import { logger } from '@utils/logger';
import { Pool as PgPool } from 'pg';
import { Pool as MysqlPool } from 'mysql2/promise';

@Service()
export class SQLSchemaDetectorService {
    public async getSchemaAsString(dbType: 'postgres' | 'mysql', pool: any): Promise<string> {
        try {
            if (dbType === 'postgres') {
                const tablesRes = await pool.query(
                    `SELECT table_schema, table_name
           FROM information_schema.tables
           WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
           ORDER BY table_schema, table_name`,
                );

                const result: Array<{ table: string; columns: Array<{ column_name: string; data_type: string; is_nullable: string }> }> = [];
                for (const row of tablesRes.rows) {
                    const colsRes = await pool.query(
                        `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema=$1 AND table_name=$2
             ORDER BY ordinal_position`,
                        [row.table_schema, row.table_name],
                    );
                    result.push({ table: `${row.table_schema}.${row.table_name}`, columns: colsRes.rows });
                }
                return JSON.stringify(result, null, 2);
            } else {
                const [tables] = await pool.query(
                    `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
           FROM information_schema.tables
           WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA = DATABASE()
           ORDER BY TABLE_SCHEMA, TABLE_NAME`,
                );

                const result: Array<{ table: string; columns: Array<{ column_name: string; data_type: string; is_nullable: string }> }> = [];
                for (const row of tables as any[]) {
                    const [cols] = await pool.query(
                        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
             FROM information_schema.columns
             WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
             ORDER BY ORDINAL_POSITION`,
                        [row.table_schema, row.table_name],
                    );
                    result.push({ table: `${row.table_schema}.${row.table_name}`, columns: cols as any[] });
                }
                return JSON.stringify(result, null, 2);
            }
        } catch (e: any) {
            logger.error(`SQL schema detection failed: ${e.message}`);
            return '[]';
        }
    }
}