import { Env } from './worker';

interface ExportOptions {
    batchSize?: number;
    tableName: string;
    orderBy?: string;
    whereClause?: string;
}

/**
 * Stream export D1 data in batches to avoid memory issues
 */
export async function* streamTableData(env: Env, options: ExportOptions) {
    const { tableName, batchSize = 1000, orderBy = 'id', whereClause } = options;

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const whereSQL = whereClause ? `WHERE ${whereClause}` : '';
        const sql = `
      SELECT * FROM ${tableName} 
      ${whereSQL}
      ORDER BY ${orderBy} 
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
export async function getTableSchema(env: Env, tableName: string) {
    const stmt = env.DB.prepare(`PRAGMA table_info(${tableName})`);
    const result = await stmt.all();
    return result.results;
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
    schema: any[]
): string[] {
    if (rows.length === 0) return [];

    const columns = schema.map(col => col.name);
    const columnList = columns.join(', ');

    return rows.map(row => {
        const values = columns.map(col => {
            const value = row[col];
            if (value === null) return 'NULL';
            if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
            if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
            return value;
        }).join(', ');

        return `INSERT INTO ${tableName} (${columnList}) VALUES (${values}) ON CONFLICT DO NOTHING;`;
    });
} 