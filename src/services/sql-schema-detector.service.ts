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

        // Preload primary keys
        const pkRes = await pool.query(
          `SELECT tc.table_schema, tc.table_name, kcu.column_name
             FROM information_schema.table_constraints AS tc
             JOIN information_schema.key_column_usage AS kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema NOT IN ('pg_catalog','information_schema')`,
        );
        const tableToPk = new Map<string, string[]>();
        for (const r of pkRes.rows) {
          const t = `${r.table_schema}.${r.table_name}`;
          if (!tableToPk.has(t)) tableToPk.set(t, []);
          tableToPk.get(t)!.push(r.column_name);
        }

        // Preload foreign keys
        const fkRes = await pool.query(
          `SELECT
               tc.table_schema AS table_schema,
               tc.table_name AS table_name,
               kcu.column_name AS column_name,
               ccu.table_schema AS ref_table_schema,
               ccu.table_name AS ref_table_name,
               ccu.column_name AS ref_column_name,
               tc.constraint_name AS constraint_name
             FROM information_schema.table_constraints AS tc
             JOIN information_schema.key_column_usage AS kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage AS ccu
               ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema NOT IN ('pg_catalog','information_schema')`,
        );
        const tableToFks = new Map<
          string,
          Array<{ column_name: string; references_table: string; references_column: string; constraint_name: string }>
        >();
        for (const r of fkRes.rows) {
          const t = `${r.table_schema}.${r.table_name}`;
          if (!tableToFks.has(t)) tableToFks.set(t, []);
          tableToFks.get(t)!.push({
            column_name: r.column_name,
            references_table: `${r.ref_table_schema}.${r.ref_table_name}`,
            references_column: r.ref_column_name,
            constraint_name: r.constraint_name,
          });
        }

        const result: Array<{
          table: string;
          columns: Array<{ column_name: string; data_type: string; is_nullable: string }>;
          primary_key?: string[];
          foreign_keys?: Array<{ column_name: string; references_table: string; references_column: string; constraint_name: string }>;
        }> = [];
        for (const row of tablesRes.rows) {
          const colsRes = await pool.query(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema=$1 AND table_name=$2
             ORDER BY ordinal_position`,
            [row.table_schema, row.table_name],
          );
          const tableName = `${row.table_schema}.${row.table_name}`;
          result.push({
            table: tableName,
            columns: colsRes.rows,
            primary_key: tableToPk.get(tableName) || [],
            foreign_keys: tableToFks.get(tableName) || [],
          });
        }
        return JSON.stringify(result, null, 2);
      } else {
        const [tables] = await pool.query(
          `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
           FROM information_schema.tables
           WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA = DATABASE()
           ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        );

        // Preload primary keys
        const [pkRows] = await pool.query(
          `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY'`,
        );
        const tableToPk = new Map<string, string[]>();
        for (const r of pkRows as any[]) {
          const t = `${r.table_schema}.${r.table_name}`;
          if (!tableToPk.has(t)) tableToPk.set(t, []);
          tableToPk.get(t)!.push(r.column_name);
        }

        // Preload foreign keys
        const [fkRows] = await pool.query(
          `SELECT
               kcu.TABLE_SCHEMA AS table_schema,
               kcu.TABLE_NAME AS table_name,
               kcu.COLUMN_NAME AS column_name,
               kcu.REFERENCED_TABLE_SCHEMA AS ref_table_schema,
               kcu.REFERENCED_TABLE_NAME AS ref_table_name,
               kcu.REFERENCED_COLUMN_NAME AS ref_column_name,
               rc.CONSTRAINT_NAME AS constraint_name
             FROM information_schema.KEY_COLUMN_USAGE AS kcu
             JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
               ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
              AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
            WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
        );
        const tableToFks = new Map<
          string,
          Array<{ column_name: string; references_table: string; references_column: string; constraint_name: string }>
        >();
        for (const r of fkRows as any[]) {
          const t = `${r.table_schema}.${r.table_name}`;
          if (!tableToFks.has(t)) tableToFks.set(t, []);
          tableToFks.get(t)!.push({
            column_name: r.column_name,
            references_table: `${r.ref_table_schema}.${r.ref_table_name}`,
            references_column: r.ref_column_name,
            constraint_name: r.constraint_name,
          });
        }

        const result: Array<{
          table: string;
          columns: Array<{ column_name: string; data_type: string; is_nullable: string }>;
          primary_key?: string[];
          foreign_keys?: Array<{ column_name: string; references_table: string; references_column: string; constraint_name: string }>;
        }> = [];
        for (const row of tables as any[]) {
          const [cols] = await pool.query(
            `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
             FROM information_schema.columns
             WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
             ORDER BY ORDINAL_POSITION`,
            [row.table_schema, row.table_name],
          );
          const tableName = `${row.table_schema}.${row.table_name}`;
          result.push({
            table: tableName,
            columns: cols as any[],
            primary_key: tableToPk.get(tableName) || [],
            foreign_keys: tableToFks.get(tableName) || [],
          });
        }
        return JSON.stringify(result, null, 2);
      }
    } catch (e: any) {
      logger.error(`SQL schema detection failed: ${e.message}`);
      return '[]';
    }
  }
}
