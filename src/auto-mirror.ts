import { Env } from './worker';
import { convertSqlitePlaceholdersToPostgres, normalizeParams } from './sql-utils';

export class AutoMirrorDB {
    constructor(private env: Env) { }

    async patchDB() {
        const originalPrepare = this.env.DB.prepare.bind(this.env.DB);

        this.env.DB.prepare = (sql: string) => {
            const statement = originalPrepare(sql);
            const originalBind = statement.bind.bind(statement);
            const patchedStatement = this.patchStatement(statement, sql, []);

            patchedStatement.bind = (...args: unknown[]) => {
                const normalizedParams = normalizeParams(args);
                const boundStatement = originalBind(...args as []);
                return this.patchStatement(boundStatement, sql, normalizedParams);
            };

            return patchedStatement;
        };
    }

    private patchStatement(statement: D1PreparedStatement, sql: string, params: unknown[]) {
        const boundParams = [...params];
        const isWriteOperation = this.isWriteSQL(sql);

        const originalRun = statement.run.bind(statement);
        const originalAll = statement.all.bind(statement);
        const originalFirst = statement.first.bind(statement);

        statement.run = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
            const result = await originalRun<T>();
            if (isWriteOperation) {
                await this.mirrorToPostgres(sql, boundParams);
            }
            return result;
        };

        statement.all = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
            const result = await originalAll<T>();
            if (isWriteOperation) {
                await this.mirrorToPostgres(sql, boundParams);
            }
            return result;
        };

        statement.first = async <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
            const result = await (colName ? originalFirst<T>(colName) : originalFirst<T>());
            if (isWriteOperation) {
                await this.mirrorToPostgres(sql, boundParams);
            }
            return result;
        };

        return statement;
    }

    private isWriteSQL(sql: string): boolean {
        const cleanSql = sql
            .replace(/--.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (!cleanSql) return false;

        const statements = cleanSql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        return statements.some(statement => {
            const firstWord = statement.split(/\s+/)[0];
            return ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter'].includes(firstWord);
        });
    }

    private async mirrorToPostgres(sql: string, params: unknown[]) {
        try {
            const pgSql = convertSqlitePlaceholdersToPostgres(sql);
            const opId = crypto.randomUUID();

            await this.env.MIRROR_QUEUE.send({
                sql: pgSql,
                params: [...params],
                opId
            });
        } catch (error) {
            console.error('Failed to queue mirror operation:', error);
        }
    }
}
