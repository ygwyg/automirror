import { Env } from './worker';

export async function writeNote(env: Env, title: string, content: string, opId: string) {
    const sql_d1 = "INSERT INTO notes (title, content, op_id) VALUES (?, ?, ?)";
    const sql_pg = "INSERT INTO notes (title, content, op_id) VALUES ($1, $2, $3) ON CONFLICT (op_id) DO NOTHING";

    if (env.PRIMARY_DB === "pg") {
        // Postgres primary: write to PG first, then mirror to D1
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            throw new Error('Postgres connection string not configured');
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();
            await client.query(sql_pg, [title, content, opId]);
        } catch (error) {
            console.error('Failed to write to Postgres:', error);
            throw new Error('Database write failed');
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }

        // Mirror to D1 (don't fail the request if this fails)
        try {
            await env.DB.prepare(sql_d1).bind(title, content, opId).run();
        } catch (error) {
            console.error('Failed to mirror write to D1:', error);
            // Continue - this is just a backup
        }
    } else {
        // D1 primary: write to D1, auto-mirror to PG via queue
        try {
            await env.DB.prepare(sql_d1).bind(title, content, opId).run();
        } catch (error) {
            console.error('Failed to write to D1:', error);
            throw new Error('Database write failed');
        }

        // Queue mirroring happens automatically via AutoMirrorDB
    }

    return { opId };
}

export async function readNotes(env: Env) {
    const sql = "SELECT * FROM notes ORDER BY id DESC";

    if (env.PRIMARY_DB === "pg") {
        // Read from Postgres
        const { Client } = await import("pg");
        const dsn = env.PG_DSN ?? env.PG?.connectionString;

        if (!dsn) {
            throw new Error('Postgres connection string not configured');
        }

        const client = new Client({ connectionString: dsn });

        try {
            await client.connect();
            const { rows } = await client.query(sql);
            return rows;
        } catch (error) {
            console.error('Failed to read from Postgres:', error);
            throw new Error('Database read failed');
        } finally {
            try {
                await client.end();
            } catch (error) {
                console.error('Error closing Postgres connection:', error);
            }
        }
    } else {
        // Read from D1
        try {
            const stmt = env.DB.prepare(sql);
            const data = await stmt.all();
            return data.results;
        } catch (error) {
            console.error('Failed to read from D1:', error);
            throw new Error('Database read failed');
        }
    }
} 