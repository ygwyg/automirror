import { Env } from './worker';
import { TableColumn, deriveOrderingColumns, formatPostgresValue, quoteIdentifier } from './sql-utils';

interface ExportOptions {
    batchSize?: number;
    tableName: string;
    orderBy?: string | string[];
    whereClause?: string;
    schema?: TableColumn[];
}

/**
 * Stream export D1 data in batches to avoid memory issues
 */
export async function* streamTableData(env: Env, options: ExportOptions) {
    const { tableName, batchSize = 1000, orderBy, whereClause, schema } = options;

    const orderingColumns = Array.isArray(orderBy)
        ? orderBy
        : orderBy
            ? [orderBy]
            : deriveOrderingColumns(schema);

    const tableIdentifier = quoteIdentifier(tableName);
    const resolvedOrdering = orderingColumns.length > 0 ? orderingColumns : ['rowid'];
    const orderByClause = resolvedOrdering
        .map(column => column.toLowerCase() === 'rowid' ? 'rowid' : quoteIdentifier(column))
        .join(', ');

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const whereSQL = whereClause ? `WHERE ${whereClause}` : '';
        const sql = `
      SELECT * FROM ${tableIdentifier}
      ${whereSQL}
      ORDER BY ${orderByClause}
      LIMIT ${batchSize}
      OFFSET ${offset}
    `;

        const stmt = env.DB.prepare(sql);
        const result = await stmt.all();
        const rows = result.results;

        if (rows.length === 0) {
            hasMore = false;
            break;
        }

        yield {
            rows,
            offset,
            batchNumber: Math.floor(offset / batchSize) + 1,
            hasMore: rows.length === batchSize
        };

        offset += batchSize;
        hasMore = rows.length === batchSize;
    }
}

/**
 * Get table schema information from D1
 */
export async function getTableSchema(env: Env, tableName: string): Promise<TableColumn[]> {
    const stmt = env.DB.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    const result = await stmt.all();
    return result.results as unknown as TableColumn[];
}

/**
 * Get all table names from D1
 */
export async function getAllTables(env: Env): Promise<string[]> {
    const stmt = env.DB.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
    const result = await stmt.all();
    return result.results.map((row: any) => row.name);
}

/**
 * Generate INSERT statements for Postgres from D1 data
 */
export function generatePostgresInserts(
    tableName: string,
    rows: any[],
    schema: TableColumn[]
): string[] {
    if (rows.length === 0) return [];

    const columns = schema.map(col => col.name);
    const quotedTableName = quoteIdentifier(tableName);
    const columnList = columns.map(quoteIdentifier).join(', ');

    return rows.map(row => {
        const values = columns.map(col => formatPostgresValue(row[col] ?? null)).join(', ');

        return `INSERT INTO ${quotedTableName} (${columnList}) VALUES (${values}) ON CONFLICT DO NOTHING;`;
    });
}