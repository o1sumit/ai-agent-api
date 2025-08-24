import { Service } from 'typedi';
import { SchemaRegistryModel, SchemaRegistryDoc } from '@models/schema-registry.model';
import { SchemaDetectorService } from './schema-detector.service';
import { SQLSchemaDetectorService } from './sql-schema-detector.service';
import { DBType } from '@interfaces/ai-agent.interface';
import { logger } from '@utils/logger';

@Service()
export class SchemaRegistryService {
  private schemaDetector = new SchemaDetectorService();
  private sqlSchemaDetector = new SQLSchemaDetectorService();
  private DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  public async getOrBuildSchemaString(
    dbUrl: string,
    dbType: DBType,
    connection: any,
    forceRefresh = false,
  ): Promise<string> {
    const normalizedUrl = this.normalizeUrl(dbUrl, dbType);
    const dbKey = `${dbType}:${normalizedUrl}`;

    const existing = await SchemaRegistryModel.findOne({ dbKey });
    if (existing && !forceRefresh && !this.isStale(existing)) {
      return existing.schemaJson;
    }

    const schemaJson = await this.buildSchemaJson(dbType, connection);
    const summary = this.extractSummary(schemaJson, dbType);

    if (existing) {
      existing.schemaJson = schemaJson;
      existing.lastUpdated = new Date();
      existing.totalCollections = summary.totalCollections;
      existing.totalTables = summary.totalTables;
      existing.ttlMs = existing.ttlMs || this.DEFAULT_TTL_MS;
      await existing.save();
    } else {
      await SchemaRegistryModel.create({
        dbKey,
        dbType,
        normalizedUrl,
        schemaJson,
        totalCollections: summary.totalCollections,
        totalTables: summary.totalTables,
        lastUpdated: new Date(),
        ttlMs: this.DEFAULT_TTL_MS,
      });
    }

    return schemaJson;
  }

  private isStale(doc: SchemaRegistryDoc): boolean {
    return Date.now() - new Date(doc.lastUpdated).getTime() > (doc.ttlMs || this.DEFAULT_TTL_MS);
  }

  private async buildSchemaJson(dbType: DBType, connection: any): Promise<string> {
    try {
      if (dbType === 'mongodb' && connection.type === 'mongodb') {
        const schemas = await this.schemaDetector.getAllSchemas(connection.mongo);
        return this.schemaDetector.getSchemaAsString(schemas);
      } else if (dbType === 'postgres' && connection.type === 'postgres') {
        return await this.sqlSchemaDetector.getSchemaAsString('postgres', connection.pg);
      } else if (dbType === 'mysql' && connection.type === 'mysql') {
        return await this.sqlSchemaDetector.getSchemaAsString('mysql', connection.mysql);
      }
      throw new Error(`Unsupported combination: ${dbType}/${connection.type}`);
    } catch (e: any) {
      logger.error(`Schema build failed: ${e.message}`);
      return '[]';
    }
  }

  private extractSummary(schemaJson: string, dbType: DBType): { totalCollections?: number; totalTables?: number } {
    try {
      const parsed = JSON.parse(schemaJson);
      if (dbType === 'mongodb' && Array.isArray(parsed)) return { totalCollections: parsed.length };
      if ((dbType === 'postgres' || dbType === 'mysql') && Array.isArray(parsed)) return { totalTables: parsed.length };
      return {};
    } catch {
      return {};
    }
  }

  private normalizeUrl(dbUrl: string, _dbType: DBType): string {
    let stripped = dbUrl.replace(/\/\/[^@]+@/, '//');
    const qIndex = stripped.indexOf('?');
    if (qIndex >= 0) stripped = stripped.substring(0, qIndex);
    return stripped;
  }
}


