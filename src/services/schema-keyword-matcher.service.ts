import { Service } from 'typedi';
import { SchemaDetectorService } from './schema-detector.service';
import { logger } from '@utils/logger';
import { DBType } from '@interfaces/ai-agent.interface';

@Service()
export class SchemaKeywordMatcherService {
  private detector = new SchemaDetectorService();

  public async match(
    userQuery: string,
    options: { schemaJson?: string; dbConnection?: any; dbType?: DBType },
  ): Promise<{ candidates: Array<{ name: string; type: 'table' | 'collection'; fields: string[] }>; keywords: string[] }> {
    const keywords = this.extractKeywords(userQuery);
    try {
      // Prefer provided schemaJson to avoid re-querying the DB
      if (options.schemaJson) {
        const candidates = this.fromSchemaJson(options.schemaJson, options.dbType || 'mongodb', keywords);
        return { candidates, keywords };
      }

      const dbConn = options.dbConnection;
      if (dbConn?.type === 'mongodb') {
        const schemas = await this.detector.getAllSchemas(dbConn.mongo);
        const candidates: Array<{ name: string; type: 'collection'; fields: string[] }> = [] as any;
        for (const s of schemas) {
          const name = String(s.collection || '').toLowerCase();
          const fields = (s.fields || []).map((f: any) => String(f.name || '').toLowerCase());
          if (this.matches(name, fields, keywords)) candidates.push({ name: s.collection, type: 'collection', fields: Array.from(new Set(fields)) });
        }
        return { candidates, keywords } as any;
      }

      // SQL fallback: without schemaJson we cannot fetch structure cheaply here
      return { candidates: [], keywords };
    } catch (e: any) {
      logger.warn(`SchemaKeywordMatcher failed: ${e.message}`);
      return { candidates: [], keywords };
    }
  }

  private fromSchemaJson(
    schemaJson: string,
    dbType: DBType,
    keywords: string[],
  ): Array<{ name: string; type: 'table' | 'collection'; fields: string[] }> {
    try {
      const parsed = JSON.parse(schemaJson);
      if (!Array.isArray(parsed)) return [];

      if (dbType === 'mongodb') {
        // Expecting [{ collection, fields: [{ name }] }]
        const candidates: Array<{ name: string; type: 'collection'; fields: string[] }> = [] as any;
        for (const s of parsed) {
          const name = String(s.collection || '').toLowerCase();
          const fields = Array.isArray(s.fields) ? s.fields.map((f: any) => String(f.name || '').toLowerCase()) : [];
          if (this.matches(name, fields, keywords)) candidates.push({ name: s.collection, type: 'collection', fields: Array.from(new Set(fields)) });
        }
        return candidates;
      } else {
        // SQL structure from SQLSchemaDetectorService: [{ table: 'schema.table', columns: [{ column_name }] }]
        const candidates: Array<{ name: string; type: 'table'; fields: string[] }> = [] as any;
        for (const t of parsed) {
          const name = String(t.table || '').toLowerCase();
          const fields = Array.isArray(t.columns) ? t.columns.map((c: any) => String(c.column_name || '').toLowerCase()) : [];
          if (this.matches(name, fields, keywords)) candidates.push({ name: t.table, type: 'table', fields: Array.from(new Set(fields)) });
        }
        return candidates;
      }
    } catch (e: any) {
      logger.warn(`SchemaKeywordMatcher parse failed: ${e.message}`);
      return [];
    }
  }

  private extractKeywords(query: string): string[] {
    const stop = new Set([
      'get',
      'find',
      'show',
      'all',
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'is',
      'are',
      'be',
      'can',
      'most',
      'top',
      'best',
      'over',
      'last',
      'from',
      'this',
      'that',
      'these',
      'those',
    ]);
    return (query || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length > 2 && !stop.has(w));
  }

  private matches(name: string, fields: string[], keywords: string[]): boolean {
    return keywords.some(k => name.includes(k) || fields.some(f => f.includes(k)));
  }
}
