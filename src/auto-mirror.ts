import { Env } from './worker';

export class AutoMirrorDB {
    constructor(private env: Env) { }

    async patchDB() {
        const originalPrepare = this.env.DB.prepare.bind(this.env.DB);

        this.env.DB.prepare = (sql: string) => {
            const stmt = originalPrepare(sql);
            const originalBind = stmt.bind.bind(stmt);

            stmt.bind = (...params: unknown[]) => {
                const bound = originalBind(...params);

                // Patch all methods that can execute write operations
                const originalRun = bound.run.bind(bound);
                const originalAll = bound.all.bind(bound);
                const originalFirst = bound.first.bind(bound);

                // Only mirror if this is a write operation (INSERT, UPDATE, DELETE)
                const isWriteOperation = this.isWriteSQL(sql);

                bound.run = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
                    const result = await originalRun<T>();
                    if (isWriteOperation) {
                        await this.mirrorToPostgres(sql, params);
                    }
                    return result;
                };

                bound.all = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
                    const result = await originalAll<T>();
                    if (isWriteOperation) {
                        await this.mirrorToPostgres(sql, params);
                    }
                    return result;
                };

                bound.first = async <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
                    const result = await (colName ? originalFirst<T>(colName) : originalFirst<T>());
                    if (isWriteOperation) {
                        await this.mirrorToPostgres(sql, params);
                    }
                    return result;
                };

                return bound;
            };

            return stmt;
        };
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
            const pgSql = this.convertPlaceholders(sql, params.length);
            const opId = crypto.randomUUID();

            await this.env.MIRROR_QUEUE.send({
                sql: pgSql,
                params,
                opId
            });
        } catch (error) {
            console.error('Failed to queue mirror operation:', error);
            // Don't throw - we don't want mirroring failures to break the main operation
        }
    }

    private convertPlaceholders(sql: string, count: number): string {
        let i = 1;
        return sql.replace(/\?/g, () => `$${i++}`);
    }
} 