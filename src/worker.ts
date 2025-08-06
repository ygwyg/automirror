import { executeQuery, getTableInfo, getAllTables } from './db-router';
import { AutoMirrorDB } from './auto-mirror';
import { handleExport } from './export-worker';

export interface Env {
    DB: D1Database;
    PG?: { connectionString: string };
    PG_DSN?: string;
    MIRROR_QUEUE: Queue;
    PRIMARY_DB: string;
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        try {
            const db = new AutoMirrorDB(env);
            await db.patchDB();

            const url = new URL(req.url);

            // Generic SQL execution endpoint
            if (req.method === "POST" && url.pathname === "/execute") {
                try {
                    const body = await req.json() as { sql: string; params?: unknown[] };
                    const { sql, params = [] } = body;

                    // Basic input validation
                    if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
                        return Response.json({ error: 'SQL query is required' }, { status: 400 });
                    }

                    // Limit SQL length to prevent abuse
                    if (sql.length > 10000) {
                        return Response.json({ error: 'SQL query too long (max 10,000 characters)' }, { status: 400 });
                    }

                    if (!Array.isArray(params)) {
                        return Response.json({ error: 'Parameters must be an array' }, { status: 400 });
                    }

                    const result = await executeQuery(env, sql.trim(), params);
                    return Response.json(result);
                } catch (error) {
                    console.error('Error executing query:', error);
                    if (error instanceof SyntaxError) {
                        return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
                    }
                    return Response.json({ error: 'Failed to execute query' }, { status: 500 });
                }
            }

            // Get database schema information
            if (req.method === "GET" && url.pathname === "/schema") {
                try {
                    const tables = await getAllTables(env);
                    const schema: Record<string, any[]> = {};

                    for (const table of tables) {
                        schema[table] = await getTableInfo(env, table);
                    }

                    return Response.json({ tables, schema });
                } catch (error) {
                    console.error('Error getting schema:', error);
                    return Response.json({ error: 'Failed to get database schema' }, { status: 500 });
                }
            }

            // Get list of tables
            if (req.method === "GET" && url.pathname === "/tables") {
                try {
                    const tables = await getAllTables(env);
                    return Response.json({ tables });
                } catch (error) {
                    console.error('Error getting tables:', error);
                    return Response.json({ error: 'Failed to get tables' }, { status: 500 });
                }
            }

            // Export data endpoint
            if (req.method === "GET" && url.pathname === "/export") {
                return handleExport(req, env);
            }

            // Generate migration script
            if (req.method === "GET" && url.pathname === "/migration-script") {
                try {
                    const tables = await getAllTables(env);
                    const schema: Record<string, any[]> = {};

                    for (const table of tables) {
                        schema[table] = await getTableInfo(env, table);
                    }

                    const migrationScript = await generatePostgresMigrationScript(schema);

                    return new Response(migrationScript, {
                        headers: {
                            'Content-Type': 'text/plain',
                            'Content-Disposition': 'attachment; filename="postgres-migration.sql"'
                        }
                    });
                } catch (error) {
                    console.error('Error generating migration script:', error);
                    return Response.json({ error: 'Failed to generate migration script' }, { status: 500 });
                }
            }

            return new Response("Not found", { status: 404 });
        } catch (error) {
            console.error('Worker error:', error);
            return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
    },

    async queue(batch: MessageBatch<any>, env: Env) {
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            console.error('No Postgres connection string configured');
            return;
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();
            console.log(`Processing ${batch.messages.length} queued operations`);

            for (const msg of batch.messages) {
                try {
                    const { sql, params } = msg.body;

                    if (!sql || !Array.isArray(params)) {
                        console.error('Invalid message format:', msg.body);
                        msg.ack(); // Ack invalid messages to prevent reprocessing
                        continue;
                    }

                    await client.query("BEGIN");
                    await client.query(sql, params);
                    await client.query("COMMIT");
                    msg.ack();
                    console.log('Successfully mirrored operation to Postgres');
                } catch (error) {
                    console.error('Failed to process queue message:', error);
                    await client.query("ROLLBACK");
                    // Don't ack failed messages - they'll be retried
                }
            }
        } catch (error) {
            console.error('Queue processing error:', error);
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }
    }
};

async function generatePostgresMigrationScript(schema: Record<string, any[]>): Promise<string> {
    const { convertD1SchemaToPostgres } = await import('./schema-helper');
    return convertD1SchemaToPostgres(schema);
} 