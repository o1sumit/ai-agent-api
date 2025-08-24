import { Service } from 'typedi';
import { SchemaDetectorService } from './schema-detector.service';
import { logger } from '@utils/logger';

type SqlType = 'postgres' | 'mysql';

@Service()
export class DataProfilerService {
  private schemaDetector = new SchemaDetectorService();

  public async getCapabilitiesSummary(dbConnection: any): Promise<string> {
    try {
      if (dbConnection.type === 'mongodb') {
        return await this.profileMongo(dbConnection.mongo);
      } else if (dbConnection.type === 'postgres' || dbConnection.type === 'mysql') {
        return await this.profileSQL(dbConnection.type, dbConnection.type === 'postgres' ? dbConnection.pg : dbConnection.mysql);
      }
      return 'Capabilities: Unknown database type.';
    } catch (e: any) {
      logger.warn(`Data profiling failed: ${e.message}`);
      return 'Capabilities: Profiling failed.';
    }
  }

  private async profileMongo(conn: any): Promise<string> {
    const schemas = await this.schemaDetector.getAllSchemas(conn);
    const collectionNames = schemas.map(s => s.collection.toLowerCase());
    const fieldsByColl: Record<string, Set<string>> = {};
    for (const s of schemas) {
      fieldsByColl[s.collection] = new Set(s.fields.map(f => f.name.toLowerCase()));
    }

    // Heuristics
    const hasProducts = collectionNames.some(n => n.includes('product'));
    const hasOrders = collectionNames.some(n => n.includes('order')) || collectionNames.some(n => n.includes('sale'));
    const productFields = Object.values(fieldsByColl).flatMap(set => Array.from(set));
    const hasQty = productFields.some(f => /quantity|qty/.test(f));
    const hasPrice = productFields.some(f => /price|amount|total/.test(f));
    const hasDate = productFields.some(f => /created|date|timestamp/.test(f));

    const caps: string[] = [];
    if (hasProducts && hasOrders && (hasQty || hasPrice)) caps.push('top_selling_products');
    if (hasOrders && hasDate && (hasPrice || hasQty)) caps.push('revenue_over_time');
    if (hasOrders) caps.push('order_counts');

    return `Collections: ${schemas.map(s => s.collection).join(', ')}\nCapabilities: ${caps.join(', ') || 'basic_find'}\nSignals: qty=${hasQty}, price=${hasPrice}, date=${hasDate}`;
  }

  private async profileSQL(dbType: SqlType, pool: any): Promise<string> {
    const tableQuery = dbType === 'postgres'
      ? `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')`
      : `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()`;

    const colQuery = dbType === 'postgres'
      ? `SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')`
      : `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE()`;

    const tables = dbType === 'postgres' ? (await pool.query(tableQuery)).rows : (await pool.query(tableQuery))[0];
    const cols = dbType === 'postgres' ? (await pool.query(colQuery)).rows : (await pool.query(colQuery))[0];

    const fullNames: string[] = tables.map((t: any) => dbType === 'postgres' ? `${t.table_schema}.${t.table_name}` : t.table_name);
    const tableToCols = new Map<string, Set<string>>();
    for (const c of cols) {
      const t = dbType === 'postgres' ? `${c.table_schema}.${c.table_name}` : c.table_name;
      if (!tableToCols.has(t)) tableToCols.set(t, new Set());
      tableToCols.get(t)!.add(String(c.column_name).toLowerCase());
    }

    const candidates = fullNames.map(t => ({ name: t, score: this.scoreTable(tableToCols.get(t) || new Set()) }))
      .sort((a, b) => b.score - a.score);

    const topTables = candidates.slice(0, 8).map(c => c.name);

    // Capability heuristics
    const flatCols = Array.from(tableToCols.values()).flatMap(s => Array.from(s));
    const hasQty = flatCols.some(f => /quantity|qty/.test(f));
    const hasPrice = flatCols.some(f => /price|unit_price|amount|total|revenue/.test(f));
    const hasDate = flatCols.some(f => /created|date|timestamp|order_date/.test(f));
    const hasProductRef = flatCols.some(f => /product_id|productid|sku|item_id/.test(f));

    const caps: string[] = [];
    if (hasProductRef && (hasQty || hasPrice)) caps.push('top_selling_products');
    if (hasDate && (hasPrice || hasQty)) caps.push('revenue_over_time');
    if (hasDate) caps.push('activity_over_time');

    return `Tables: ${topTables.join(', ')}\nCapabilities: ${caps.join(', ') || 'basic_sql'}\nSignals: qty=${hasQty}, price=${hasPrice}, date=${hasDate}, productRef=${hasProductRef}`;
  }

  private scoreTable(cols: Set<string>): number {
    let s = 0;
    for (const c of cols) {
      if (/id$/.test(c)) s += 0.5;
      if (/name|title/.test(c)) s += 0.5;
      if (/quantity|qty|price|amount|total|revenue/.test(c)) s += 1.0;
      if (/created|date|timestamp/.test(c)) s += 0.7;
      if (/product/.test(c)) s += 0.6;
      if (/order/.test(c)) s += 0.6;
    }
    return s;
  }
}


