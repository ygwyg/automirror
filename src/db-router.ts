import { Env } from './worker';

export async function executeQuery(env: Env, sql: string, params: unknown[] = []) {
    if (env.PRIMARY_DB === "pg") {
        // Execute on Postgres primary
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            throw new Error('Postgres connection string not configured');
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();

            // Convert D1 placeholders to Postgres placeholders
            const pgSql = convertPlaceholders(sql, params.length);
            const result = await client.query(pgSql, params);

            // Return in D1-compatible format
            return {
                success: true,
                results: result.rows,
                meta: {
                    changes: result.rowCount || 0,
                    last_row_id: null, // Postgres doesn't have a direct equivalent
                    rows_read: result.rowCount || 0,
                    rows_written: result.rowCount || 0
                }
            };
        } catch (error) {
            console.error('Failed to execute query on Postgres:', error);
            throw new Error('Database query failed');
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }
    } else {
        // Execute on D1 primary
        try {
            const stmt = env.DB.prepare(sql);
            const bound = params.length > 0 ? stmt.bind(...params) : stmt;

            // Determine if this is a SELECT query or a write operation
            const isSelect = sql.trim().toLowerCase().startsWith('select');

            if (isSelect) {
                const result = await bound.all();
                return {
                    success: true,
                    results: result.results,
                    meta: result.meta
                };
            } else {
                const result = await bound.run();
                return {
                    success: true,
                    results: [],
                    meta: result.meta
                };
            }
        } catch (error) {
            console.error('Failed to execute query on D1:', error);
            throw new Error('Database query failed');
        }
    }
}

export async function getTableInfo(env: Env, tableName: string) {
    const sql = `PRAGMA table_info(${tableName})`;

    if (env.PRIMARY_DB === "pg") {
        // Get table info from Postgres
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            throw new Error('Postgres connection string not configured');
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();

            // Query Postgres information_schema
            const result = await client.query(`
                SELECT 
                    ordinal_position as cid,
                    column_name as name,
                    data_type as type,
                    is_nullable = 'NO' as "notnull",
                    column_default as dflt_value,
                    CASE WHEN column_name IN (
                        SELECT column_name 
                        FROM information_schema.key_column_usage 
                        WHERE table_name = $1 
                        AND constraint_name LIKE '%_pkey'
                    ) THEN 1 ELSE 0 END as pk
                FROM information_schema.columns 
                WHERE table_name = $1 
                ORDER BY ordinal_position
            `, [tableName]);

            return result.rows;
        } catch (error) {
            console.error('Failed to get table info from Postgres:', error);
            throw new Error('Failed to get table schema');
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }
    } else {
        // Get table info from D1
        try {
            const stmt = env.DB.prepare(sql);
            const result = await stmt.all();
            return result.results;
        } catch (error) {
            console.error('Failed to get table info from D1:', error);
            throw new Error('Failed to get table schema');
        }
    }
}

export async function getAllTables(env: Env): Promise<string[]> {
    if (env.PRIMARY_DB === "pg") {
        // Get tables from Postgres
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            throw new Error('Postgres connection string not configured');
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();

            const result = await client.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_type = 'BASE TABLE'
                ORDER BY table_name
            `);

            return result.rows.map((row: any) => row.table_name);
        } catch (error) {
            console.error('Failed to get tables from Postgres:', error);
            throw new Error('Failed to get table list');
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }
    } else {
        // Get tables from D1
        try {
            const stmt = env.DB.prepare(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
            `);
            const result = await stmt.all();
            return result.results.map((row: any) => row.name);
        } catch (error) {
            console.error('Failed to get tables from D1:', error);
            throw new Error('Failed to get table list');
        }
    }
}

function convertPlaceholders(sql: string, count: number): string {
    let i = 1;
    return sql.replace(/\?/g, () => `$${i++}`);
} 