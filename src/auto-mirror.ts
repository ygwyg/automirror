import { Env } from './worker';
import { convertSqlitePlaceholdersToPostgres, PlaceholderMappingEntry, normalizeNamedBindings, buildPostgresParameterArray } from './sql-utils';

export class AutoMirrorDB {
    constructor(private env: Env) { }

    async patchDB() {
        const originalPrepare = this.env.DB.prepare.bind(this.env.DB);

        this.env.DB.prepare = (sql: string) => {
            const stmt = originalPrepare(sql);
            return this.patchStatement(stmt, sql);
        };
    }

    private patchStatement<T extends D1PreparedStatement>(stmt: T, sql: string): T {
        const { sql: pgSql, mapping } = convertSqlitePlaceholdersToPostgres(sql);
        const isWriteOperation = this.isWriteSQL(sql);

        const applyExecutionPatches = (statement: any, boundParamsProvider: () => unknown[]) => {
            const baseRun = captureOriginalMethod(statement, 'run');
            if (baseRun) {
                statement.run = async <T = Record<string, unknown>>(...args: unknown[]): Promise<D1Result<T>> => {
                    const result = await baseRun.apply(statement, args) as D1Result<T>;
                    if (isWriteOperation) {
                        const params = args.length > 0
                            ? this.normalizeParams(args, mapping)
                            : boundParamsProvider();
                        await this.mirrorToPostgres(pgSql, [...params]);
                    }
                    return result;
                };
            }

            const baseAll = captureOriginalMethod(statement, 'all');
            if (baseAll) {
                statement.all = async <T = Record<string, unknown>>(...args: unknown[]): Promise<D1Result<T>> => {
                    const result = await baseAll.apply(statement, args) as D1Result<T>;
                    if (isWriteOperation) {
                        const params = boundParamsProvider();
                        await this.mirrorToPostgres(pgSql, [...params]);
                    }
                    return result;
                };
            }

            const baseFirst = captureOriginalMethod(statement, 'first');
            if (baseFirst) {
                statement.first = async <T = Record<string, unknown>>(...args: unknown[]): Promise<T | null> => {
                    const result = await baseFirst.apply(statement, args) as T | null;
                    if (isWriteOperation) {
                        const params = boundParamsProvider();
                        await this.mirrorToPostgres(pgSql, [...params]);
                    }
                    return result;
                };
            }

            return statement;
        };

        applyExecutionPatches(stmt, () => []);

        if (typeof stmt.bind === 'function') {
            const originalBind = stmt.bind.bind(stmt);
            stmt.bind = (...bindArgs: unknown[]) => {
                const normalized = this.normalizeParams(bindArgs, mapping);
                const bound = originalBind(...bindArgs);
                applyExecutionPatches(bound, () => normalized);
                return bound;
            };
        }

        return stmt;
    }

    private isWriteSQL(sql: string): boolean {
        // Remove comments and normalize whitespace
        const cleanSql = sql
            .replace(/--.*$/gm, '') // Remove line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim()
            .toLowerCase();

        if (!cleanSql) return false;

        // Split by semicolons to handle multi-statement SQL
        const statements = cleanSql.split(';').map(s => s.trim()).filter(s => s.length > 0);

        // Check if any statement is a write operation
        return statements.some(statement => {
            const firstWord = statement.split(/\s+/)[0];
            return ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter'].includes(firstWord);
        });
    }

    private async mirrorToPostgres(sql: string, params: unknown[]) {
        try {
            const opId = crypto.randomUUID();

            await this.env.MIRROR_QUEUE.send({
                sql,
                params,
                opId
            });
        } catch (error) {
            console.error('Failed to queue mirror operation:', error);
            // Don't throw - we don't want mirroring failures to break the main operation
        }
    }

    private normalizeParams(rawParams: unknown[], mapping: PlaceholderMappingEntry[]): unknown[] {
        if (mapping.length === 0) {
            return [];
        }

        const positional: unknown[] = [];
        const named = new Map<string, unknown>();

        const addNamed = (key: string, value: unknown) => {
            normalizeNamedBindings(named, key, value);
        };

        for (const param of rawParams) {
            if (Array.isArray(param)) {
                positional.push(...param);
                continue;
            }

            if (param instanceof Map) {
                for (const [key, value] of param.entries()) {
                    if (typeof key === 'string') {
                        addNamed(key, value);
                    }
                }
                continue;
            }

            if (isPlainObject(param)) {
                for (const [key, value] of Object.entries(param)) {
                    addNamed(key, value);
                }
                continue;
            }

            positional.push(param);
        }

        return buildPostgresParameterArray(mapping, positional, named);
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

type StatementMethod = (...args: unknown[]) => Promise<unknown>;

type OriginalMethodRegistry = {
    run?: StatementMethod;
    all?: StatementMethod;
    first?: StatementMethod;
};

const originalMethodRegistry = new WeakMap<object, OriginalMethodRegistry>();

function captureOriginalMethod(statement: any, method: 'run' | 'all' | 'first'): StatementMethod | undefined {
    let registry = originalMethodRegistry.get(statement);
    if (!registry) {
        registry = {};
        originalMethodRegistry.set(statement, registry);
    }

    if (registry[method]) {
        return registry[method];
    }

    const current = statement[method];
    if (typeof current === 'function') {
        registry[method] = current as StatementMethod;
        return registry[method];
    }

    return undefined;
}