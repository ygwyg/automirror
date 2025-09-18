import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AutoMirrorDB } from '../src/auto-mirror';
import type { Env } from '../src/worker';

type TableMetadata = Record<string, Array<{ name: string; pk: number }>>;

test('INSERT OR IGNORE statements are rewritten for Postgres mirroring', async () => {
    const { env, messages } = createTestEnv({
        users: [
            { name: 'id', pk: 1 },
            { name: 'name', pk: 0 }
        ]
    });

    const db = new AutoMirrorDB(env);
    await (db as any).mirrorToPostgres('INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)', [1, 'Ada']);

    assert.equal(messages.length, 1, 'statement should be enqueued');
    assert.equal(
        messages[0].sql,
        'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT ("id") DO NOTHING'
    );
    assert.deepEqual(messages[0].params, [1, 'Ada']);
});

test('REPLACE INTO is converted to an upsert for Postgres', async () => {
    const { env, messages } = createTestEnv({
        users: [
            { name: 'id', pk: 1 },
            { name: 'name', pk: 0 },
            { name: 'email', pk: 0 }
        ]
    });

    const db = new AutoMirrorDB(env);
    await (db as any).mirrorToPostgres('REPLACE INTO users (id, name, email) VALUES (?, ?, ?)', [1, 'Ada', 'ada@example.com']);

    assert.equal(messages.length, 1, 'statement should be enqueued');
    assert.equal(
        messages[0].sql,
        'INSERT INTO users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email"'
    );
    assert.deepEqual(messages[0].params, [1, 'Ada', 'ada@example.com']);
});

test('DELETE ... LIMIT is rewritten using a limiting CTE', async () => {
    const { env, messages } = createTestEnv({
        users: [
            { name: 'id', pk: 1 },
            { name: 'name', pk: 0 }
        ]
    });

    const db = new AutoMirrorDB(env);
    await (db as any).mirrorToPostgres('DELETE FROM users WHERE name = ? LIMIT 1', ['Ada']);

    assert.equal(messages.length, 1, 'statement should be enqueued');
    assert.equal(
        messages[0].sql,
        'WITH limited AS (SELECT "id" FROM users WHERE name = $1 LIMIT 1) DELETE FROM users USING limited WHERE users."id" = limited."id"'
    );
    assert.deepEqual(messages[0].params, ['Ada']);
});

test('PRAGMA statements are skipped to avoid poisoning the queue', async () => {
    const { env, messages } = createTestEnv({ users: [{ name: 'id', pk: 1 }] });

    const db = new AutoMirrorDB(env);
    await (db as any).mirrorToPostgres('PRAGMA table_info(users)', []);

    assert.equal(messages.length, 0, 'PRAGMA should not be enqueued');
});

function createTestEnv(metadata: TableMetadata): { env: Env; messages: any[] } {
    const messages: any[] = [];
    const env: Env = {
        PRIMARY_DB: 'd1',
        PG: undefined,
        PG_DSN: undefined,
        DB: {
            prepare(sql: string) {
                const match = /PRAGMA\s+table_info\((.+)\)/i.exec(sql);
                if (!match) {
                    throw new Error(`Unexpected SQL in test stub: ${sql}`);
                }

                const tableName = match[1].replace(/["`\[\]]/g, '');
                const normalized = tableName.split('.').pop() ?? tableName;

                return {
                    all: async () => ({ results: metadata[normalized] ?? [] })
                } as any;
            }
        } as any,
        MIRROR_QUEUE: {
            async send(payload: any) {
                messages.push(payload);
            }
        } as any
    };

    return { env, messages };
}
