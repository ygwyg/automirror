import { writeNote, readNotes } from './db-router';
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

            if (req.method === "POST" && url.pathname === "/notes") {
                try {
                    const body = await req.json() as { title: string; content: string };
                    const { title, content } = body;

                    // Basic input validation
                    if (!title || typeof title !== 'string' || title.trim().length === 0) {
                        return Response.json({ error: 'Title is required and must be a non-empty string' }, { status: 400 });
                    }
                    if (!content || typeof content !== 'string' || content.trim().length === 0) {
                        return Response.json({ error: 'Content is required and must be a non-empty string' }, { status: 400 });
                    }

                    // Limit length to prevent abuse
                    if (title.length > 500) {
                        return Response.json({ error: 'Title must be 500 characters or less' }, { status: 400 });
                    }
                    if (content.length > 10000) {
                        return Response.json({ error: 'Content must be 10,000 characters or less' }, { status: 400 });
                    }

                    const opId = crypto.randomUUID();
                    const result = await writeNote(env, title.trim(), content.trim(), opId);
                    return Response.json(result);
                } catch (error) {
                    console.error('Error creating note:', error);
                    if (error instanceof SyntaxError) {
                        return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
                    }
                    return Response.json({ error: 'Failed to create note' }, { status: 500 });
                }
            }

            if (req.method === "GET" && url.pathname === "/notes") {
                try {
                    const rows = await readNotes(env);
                    return Response.json(rows);
                } catch (error) {
                    console.error('Error reading notes:', error);
                    return Response.json({ error: 'Failed to read notes' }, { status: 500 });
                }
            }

            if (req.method === "GET" && url.pathname === "/export") {
                return handleExport(req, env);
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