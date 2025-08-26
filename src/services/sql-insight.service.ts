import { Service } from 'typedi';
import { Pool as PgPool } from 'pg';
import { Pool as MysqlPool } from 'mysql2/promise';
import { logger } from '@utils/logger';

type DB = { type: 'postgres'; pg: PgPool } | { type: 'mysql'; mysql: MysqlPool };

interface SalesInsight {
  lineItemsTable?: string; // schema.table for postgres or table for mysql
  productsTable?: string;
  liProductKey?: string;
  productKey?: string;
  qtyColumn?: string;
  priceColumn?: string;
  amountColumn?: string;
  productNameColumn?: string;
}

@Service()
export class SqlInsightService {
  public async getTopSellingSQL(dbType: 'postgres' | 'mysql', pool: any): Promise<string | null> {
    try {
      const insight = await this.inferSalesSchema(dbType, pool);
      if (!insight.lineItemsTable || !insight.productsTable || !insight.liProductKey || !insight.productKey) {
        return null;
      }

      const q = (id: string) => (dbType === 'postgres' ? this.pgIdent(id) : this.myIdent(id));
      const qt = (tbl: string) => (dbType === 'postgres' ? this.pgTable(tbl) : this.myTable(tbl));

      const li = qt(insight.lineItemsTable);
      const p = qt(insight.productsTable);
      const joinLeft = `${p}.${q(insight.productKey)}`;
      const joinRight = `${li}.${q(insight.liProductKey)}`;
      const nameCol = insight.productNameColumn || 'name';

      // Prefer revenue if price + qty/amount available, else quantity
      if (insight.qtyColumn && insight.priceColumn) {
        return `SELECT ${p}.${q(nameCol)} AS product, SUM(${li}.${q(insight.qtyColumn)} * ${li}.${q(insight.priceColumn)}) AS revenue
FROM ${li} AS li
JOIN ${p} AS p ON ${joinLeft} = ${joinRight}
GROUP BY ${p}.${q(nameCol)}
ORDER BY revenue DESC
LIMIT 5`;
      }
      if (insight.amountColumn) {
        return `SELECT ${p}.${q(nameCol)} AS product, SUM(${li}.${q(insight.amountColumn)}) AS revenue
FROM ${li} AS li
JOIN ${p} AS p ON ${joinLeft} = ${joinRight}
GROUP BY ${p}.${q(nameCol)}
ORDER BY revenue DESC
LIMIT 5`;
      }
      if (insight.qtyColumn) {
        return `SELECT ${p}.${q(nameCol)} AS product, SUM(${li}.${q(insight.qtyColumn)}) AS total_quantity
FROM ${li} AS li
JOIN ${p} AS p ON ${joinLeft} = ${joinRight}
GROUP BY ${p}.${q(nameCol)}
ORDER BY total_quantity DESC
LIMIT 5`;
      }
      return null;
    } catch (e: any) {
      logger.warn(`SQL insight failed: ${e.message}`);
      return null;
    }
  }

  private async inferSalesSchema(dbType: 'postgres' | 'mysql', pool: any): Promise<SalesInsight> {
    const like = (col: string, patterns: string[]) =>
      patterns.map(p => `${col} ${dbType === 'postgres' ? `ILIKE '%${p}%'` : `LIKE '%${p}%'`}`).join(' OR ');
    let rows: Array<{ table_schema?: string; table_name: string; column_name: string }>; // mysql has no schema field in our query

    if (dbType === 'postgres') {
      const res = await pool.query(
        `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
         WHERE table_type IS NULL OR table_schema NOT IN ('pg_catalog','information_schema')
           AND (${like('column_name', [
             'product_id',
             'productid',
             'sku',
             'item_id',
             'order_id',
             'quantity',
             'qty',
             'price',
             'unit_price',
             'amount',
             'total',
             'revenue',
             'name',
             'title',
           ])})
         ORDER BY table_schema, table_name`,
      );
      rows = res.rows;
    } else {
      const [res] = await pool.query(
        `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM information_schema.columns
         WHERE TABLE_SCHEMA = DATABASE()
           AND (${like('COLUMN_NAME', [
             'product_id',
             'productid',
             'sku',
             'item_id',
             'order_id',
             'quantity',
             'qty',
             'price',
             'unit_price',
             'amount',
             'total',
             'revenue',
             'name',
             'title',
           ])})
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      );
      rows = res as any[];
    }

    const tableToCols = new Map<string, Set<string>>();
    for (const r of rows) {
      const t = dbType === 'postgres' ? `${r.table_schema}.${r.table_name}` : r.table_name;
      if (!tableToCols.has(t)) tableToCols.set(t, new Set());
      tableToCols.get(t)!.add(r.column_name.toLowerCase());
    }

    const hasAny = (cols: Set<string>, list: string[]) => list.some(k => cols.has(k));
    const pickFirst = (cols: Set<string>, list: string[]) => list.find(k => cols.has(k));

    const productTables: string[] = [];
    const lineItemTables: string[] = [];
    for (const [table, cols] of tableToCols.entries()) {
      const lname = table.toLowerCase();
      if (lname.includes('product') && hasAny(cols, ['name', 'title', 'sku'])) productTables.push(table);
      const hasProdKey = hasAny(cols, ['product_id', 'productid', 'sku', 'item_id']);
      const hasQtyOrMoney = hasAny(cols, ['quantity', 'qty', 'price', 'unit_price', 'amount', 'total']);
      if (hasProdKey && hasQtyOrMoney) lineItemTables.push(table);
    }

    const insight: SalesInsight = {};
    insight.productsTable = productTables[0];
    insight.lineItemsTable = lineItemTables[0];
    if (insight.lineItemsTable) {
      const liCols = tableToCols.get(insight.lineItemsTable)!;
      insight.liProductKey = pickFirst(liCols, ['product_id', 'productid', 'sku', 'item_id']);
      insight.qtyColumn = pickFirst(liCols, ['quantity', 'qty']);
      insight.priceColumn = pickFirst(liCols, ['unit_price', 'price']);
      insight.amountColumn = pickFirst(liCols, ['amount', 'total']);
    }
    if (insight.productsTable) {
      const pCols = tableToCols.get(insight.productsTable)!;
      insight.productKey = pickFirst(pCols, ['id', 'product_id', 'sku']);
      insight.productNameColumn = pickFirst(pCols, ['name', 'title', 'sku']) || 'name';
    }
    return insight;
  }

  private pgIdent(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }
  private myIdent(name: string): string {
    return '`' + String(name).replace(/`/g, '``') + '`';
  }
  private pgTable(tbl: string): string {
    const [schema, table] = tbl.includes('.') ? tbl.split('.') : ['public', tbl];
    return `${this.pgIdent(schema)}.${this.pgIdent(table)}`;
  }
  private myTable(tbl: string): string {
    return this.myIdent(tbl);
  }
}
