// src/services/db-pool.service.ts
import { Service } from 'typedi';
import mongoose from 'mongoose';
import { Pool as PgPool } from 'pg';
import { createPool as createMysqlPool, Pool as MysqlPool } from 'mysql2/promise';
import { logger } from '@utils/logger';
import { DBType } from '@interfaces/ai-agent.interface';

type ConnectionResult =
    | { type: 'mongodb'; mongo: mongoose.Connection }
    | { type: 'postgres'; pg: PgPool }
    | { type: 'mysql'; mysql: MysqlPool };

@Service()
export class DbPoolService {
    private mongoConnections = new Map<string, mongoose.Connection>();
    private pgPools = new Map<string, PgPool>();
    private mysqlPools = new Map<string, MysqlPool>();

    public async get(dbUrl: string, dbType?: DBType): Promise<ConnectionResult> {
        const type = dbType || this.parseDbType(dbUrl);
        if (!type) throw new Error('Unsupported or unrecognized database URL type');

        switch (type) {
            case 'mongodb':
                return { type, mongo: await this.getMongoConnection(dbUrl) };
            case 'postgres':
                return { type, pg: this.getPgPool(dbUrl) };
            case 'mysql':
                return { type, mysql: this.getMysqlPool(dbUrl) };
            default:
                throw new Error(`Unsupported database type: ${type as string}`);
        }
    }

    private parseDbType(dbUrl: string): DBType | null {
        const lower = dbUrl.toLowerCase();
        if (lower.startsWith('mongodb://') || lower.startsWith('mongodb+srv://')) return 'mongodb';
        if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return 'postgres';
        if (lower.startsWith('mysql://') || lower.startsWith('mysql2://')) return 'mysql';
        return null;
    }

    private async getMongoConnection(dbUrl: string): Promise<mongoose.Connection> {
        const existing = this.mongoConnections.get(dbUrl);
        if (existing && existing.readyState === 1) return existing;

        try {
            if (existing && existing.readyState !== 1) {
                // Try reopening
                await existing.openUri(dbUrl, { useNewUrlParser: true, useUnifiedTopology: true } as any);
                return existing;
            }

            const conn = mongoose.createConnection();
            await conn.openUri(dbUrl, { useNewUrlParser: true, useUnifiedTopology: true } as any);
            this.mongoConnections.set(dbUrl, conn);
            return conn;
        } catch (e: any) {
            logger.error(`MongoDB connection failed: ${e.message}`);
            throw e;
        }
    }

    private getPgPool(dbUrl: string): PgPool {
        const existing = this.pgPools.get(dbUrl);
        if (existing) return existing;

        const pool = new PgPool({ connectionString: dbUrl });
        this.pgPools.set(dbUrl, pool);
        return pool;
    }

    private getMysqlPool(dbUrl: string): MysqlPool {
        const existing = this.mysqlPools.get(dbUrl);
        if (existing) return existing;

        const pool = createMysqlPool(dbUrl);
        this.mysqlPools.set(dbUrl, pool);
        return pool;
    }
}