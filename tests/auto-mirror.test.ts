import assert from 'node:assert/strict';
import { AutoMirrorDB } from '../src/auto-mirror';
import { Env } from '../src/worker';

interface MirrorMessage {
    sql: string;
    params: unknown[];
    opId: string;
}

class FakeQueue {
    public readonly messages: MirrorMessage[] = [];

    async send(message: MirrorMessage): Promise<void> {
        this.messages.push(message);
    }
}

class FakeStatement {
    constructor(public readonly sql: string) { }

    bind(..._params: unknown[]): this {
        return this;
    }

    async run<T = Record<string, unknown>>(..._args: unknown[]): Promise<D1Result<T>> {
        return { success: true, results: [], meta: { changes: 1, last_row_id: 0, rows_read: 0, rows_written: 0 } } as D1Result<T>;
    }

    async all<T = Record<string, unknown>>(..._args: unknown[]): Promise<D1Result<T>> {
        return { success: true, results: [], meta: { changes: 0, last_row_id: 0, rows_read: 0, rows_written: 0 } } as D1Result<T>;
    }

    async first<T = Record<string, unknown>>(..._args: unknown[]): Promise<T | null> {
        return null;
    }
}

class FakeDB {
    prepare(sql: string): FakeStatement {
        return new FakeStatement(sql);
    }
}

function createTestEnv() {
    const queue = new FakeQueue();
    const db = new FakeDB();
    const env = {
        DB: db as unknown as D1Database,
        MIRROR_QUEUE: queue as unknown as Queue,
        PRIMARY_DB: 'd1',
    } as unknown as Env;
    return { env, queue };
}

async function testPositionalBinding() {
    const { env, queue } = createTestEnv();
    const autoMirror = new AutoMirrorDB(env);
    await autoMirror.patchDB();

    const stmt = env.DB.prepare('INSERT INTO users(name, age) VALUES (?, ?)');
    await stmt.bind('Alice', 42).run();

    assert.equal(queue.messages.length, 1, 'should enqueue a mirror message');
    const message = queue.messages[0];
    assert.equal(message.sql, 'INSERT INTO users(name, age) VALUES ($1, $2)');
    assert.deepEqual(message.params, ['Alice', 42]);
}

async function testNumberedBinding() {
    const { env, queue } = createTestEnv();
    const autoMirror = new AutoMirrorDB(env);
    await autoMirror.patchDB();

    const stmt = env.DB.prepare('INSERT INTO events(start_at, end_at) VALUES (?2, ?1)');
    await stmt.bind('2024-01-01', '2024-12-31').run();

    const [message] = queue.messages;
    assert.equal(message.sql, 'INSERT INTO events(start_at, end_at) VALUES ($1, $2)');
    assert.deepEqual(message.params, ['2024-12-31', '2024-01-01']);
}

async function testNamedBindingWithObject() {
    const { env, queue } = createTestEnv();
    const autoMirror = new AutoMirrorDB(env);
    await autoMirror.patchDB();

    const stmt = env.DB.prepare('INSERT INTO profiles(name, age, name_again) VALUES (:name, @age, $name)');
    await stmt.bind({ name: 'Bob', age: 30 }).run();

    const [message] = queue.messages;
    assert.equal(message.sql, 'INSERT INTO profiles(name, age, name_again) VALUES ($1, $2, $1)');
    assert.deepEqual(message.params, ['Bob', 30]);
}

async function testNamedBindingWithMap() {
    const { env, queue } = createTestEnv();
    const autoMirror = new AutoMirrorDB(env);
    await autoMirror.patchDB();

    const stmt = env.DB.prepare('UPDATE profiles SET name = :name WHERE id = @id OR id = $id');
    await stmt.bind(new Map([[':name', 'Carol'], ['id', 5]])).run();

    const [message] = queue.messages;
    assert.equal(message.sql, 'UPDATE profiles SET name = $1 WHERE id = $2 OR id = $2');
    assert.deepEqual(message.params, ['Carol', 5]);
}

async function run() {
    await testPositionalBinding();
    await testNumberedBinding();
    await testNamedBindingWithObject();
    await testNamedBindingWithMap();
    console.log('All tests passed');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
