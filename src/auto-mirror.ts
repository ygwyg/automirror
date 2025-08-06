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
        const trimmedSql = sql.trim().toLowerCase();
        return trimmedSql.startsWith('insert') ||
            trimmedSql.startsWith('update') ||
            trimmedSql.startsWith('delete');
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