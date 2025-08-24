import { Service } from 'typedi';
import { SchemaDetectorService } from './schema-detector.service';
import { logger } from '@utils/logger';

@Service()
export class SchemaKeywordMatcherService {
  private detector = new SchemaDetectorService();

  public async match(userQuery: string, dbConnection: any): Promise<{ candidates: Array<{ name: string; type: 'table' | 'collection'; fields: string[] }> ; keywords: string[] }> {
    const keywords = this.extractKeywords(userQuery);
    try {
      if (dbConnection.type === 'mongodb') {
        const schemas = await this.detector.getAllSchemas(dbConnection.mongo);
        const candidates: Array<{ name: string; type: 'collection'; fields: string[] }> = [] as any;
        for (const s of schemas) {
          const name = s.collection.toLowerCase();
          const fields = s.fields.map(f => f.name.toLowerCase());
          if (this.matches(name, fields, keywords)) candidates.push({ name: s.collection, type: 'collection', fields: Array.from(new Set(fields)) });
        }
        return { candidates, keywords } as any;
      } else {
        // For SQL, we don't pull full schema here; rely on capability summary and use keywords only
        return { candidates: [], keywords };
      }
    } catch (e: any) {
      logger.warn(`SchemaKeywordMatcher failed: ${e.message}`);
      return { candidates: [], keywords };
    }
  }

  private extractKeywords(query: string): string[] {
    const stop = new Set(['get','find','show','all','the','a','an','and','or','but','in','on','at','to','for','of','with','by','is','are','be','can','most','top','best','over','last','from','this','that','these','those']);
    return (query || '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length > 2 && !stop.has(w));
  }

  private matches(name: string, fields: string[], keywords: string[]): boolean {
    return keywords.some(k => name.includes(k) || fields.some(f => f.includes(k)));
  }
}


