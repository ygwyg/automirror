import type { Env } from './worker';
import { getTableInfo } from './db-router';

type TableInfoRow = { name: string; pk: number };

type TableInfoLoader = typeof getTableInfo;

export type TranslationResult =
    | { type: 'translated'; sql: string; params: unknown[] }
    | { type: 'skip'; reason: string };

export interface TranslationOptions {
    loadTableInfo?: TableInfoLoader;
}

const tableInfoCache = new Map<string, TableInfoRow[]>();

const SKIP_KEYWORDS = new Set([
    'PRAGMA',
    'VACUUM',
    'ATTACH',
    'DETACH',
    'BEGIN',
    'COMMIT',
    'ROLLBACK'
]);

export async function translateSqliteWriteToPostgres(
    env: Env,
    sql: string,
    params: unknown[],
    options: TranslationOptions = {}
): Promise<TranslationResult> {
    const loader = options.loadTableInfo ?? getTableInfo;
    const { statement, hasTerminator } = normalizeStatement(sql);

    if (!statement) {
        return { type: 'skip', reason: 'Empty SQL statement' };
    }

    if (statement.includes(';')) {
        return { type: 'skip', reason: 'Multiple statements are not supported' };
    }

    const collapsed = collapseWhitespace(statement);
    if (!collapsed) {
        return { type: 'skip', reason: 'Empty SQL statement' };
    }

    const firstToken = collapsed.split(' ')[0]?.toUpperCase();
    if (!firstToken) {
        return { type: 'skip', reason: 'Unable to determine statement type' };
    }

    if (SKIP_KEYWORDS.has(firstToken)) {
        return { type: 'skip', reason: `${firstToken} statements are not mirrored` };
    }

    const insertResult = await translateInsertLike(env, statement, loader, { hasTerminator });
    if (insertResult) {
        if ('skip' in insertResult) {
            return { type: 'skip', reason: insertResult.skip };
        }
        return { type: 'translated', sql: insertResult.sql, params };
    }

    const updateResult = await translateUpdateWithLimit(env, statement, loader, { hasTerminator });
    if (updateResult) {
        if ('skip' in updateResult) {
            return { type: 'skip', reason: updateResult.skip };
        }
        return { type: 'translated', sql: updateResult.sql, params };
    }

    const deleteResult = await translateDeleteWithLimit(env, statement, loader, { hasTerminator });
    if (deleteResult) {
        if ('skip' in deleteResult) {
            return { type: 'skip', reason: deleteResult.skip };
        }
        return { type: 'translated', sql: deleteResult.sql, params };
    }

    return { type: 'translated', sql: appendTerminator(statement, hasTerminator), params };
}

type TranslationResponse = { sql: string } | { skip: string } | null;

async function translateInsertLike(
    env: Env,
    statement: string,
    loader: TableInfoLoader,
    context: { hasTerminator: boolean }
): Promise<TranslationResponse> {
    const trimmed = statement.trimStart();
    const upper = trimmed.toUpperCase();

    let statementForParsing = statement;
    let forcedBehavior: 'REPLACE' | undefined;

    if (upper.startsWith('REPLACE')) {
        forcedBehavior = 'REPLACE';
        statementForParsing = statement.replace(/^REPLACE\s+/i, 'INSERT OR REPLACE ');
    }

    const insertMatch = /^(INSERT)\s+(?:OR\s+(IGNORE|REPLACE))?\s+INTO\s+([^\s(]+)\s*(\(([^)]*)\))?/i.exec(statementForParsing.trimStart());
    if (!insertMatch) {
        return null;
    }

    const behavior = (forcedBehavior ?? insertMatch[2]?.toUpperCase()) as ('IGNORE' | 'REPLACE' | undefined);

    if (!behavior) {
        return null;
    }

    const tableRef = insertMatch[3];
    const columnClause = insertMatch[4] ?? '';
    const rawColumnList = insertMatch[5];
    const rest = statementForParsing.slice(insertMatch[0].length).trimStart();

    const normalizedTableName = normalizeTableName(tableRef);

    const tableInfo = await fetchTableInfo(env, normalizedTableName, loader);
    if (!tableInfo || tableInfo.length === 0) {
        return { skip: `Missing table metadata for ${normalizedTableName}` };
    }

    const primaryKeys = tableInfo
        .filter(col => Number(col.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map(col => col.name);

    if (primaryKeys.length === 0) {
        return { skip: `Table ${normalizedTableName} has no primary key to use as conflict target` };
    }

    const conflictTarget = primaryKeys.map(col => quoteIdentifier(col)).join(', ');
    const insertHead = `INSERT INTO ${tableRef}${columnClause ? ` ${columnClause}` : ''}`;
    const baseInsert = `${insertHead}${rest ? ` ${rest}` : ''}`.trim();

    if (behavior === 'IGNORE') {
        const rewritten = `${baseInsert} ON CONFLICT (${conflictTarget}) DO NOTHING`;
        return { sql: appendTerminator(rewritten, context.hasTerminator) };
    }

    const parsedColumns = parseColumnList(rawColumnList, tableInfo);
    const updateColumns = parsedColumns.filter(col => !primaryKeys.includes(col));
    const columnsToUpdate = updateColumns.length > 0 ? updateColumns : parsedColumns;

    if (columnsToUpdate.length === 0) {
        return { skip: `Unable to determine columns for REPLACE on ${normalizedTableName}` };
    }

    const assignments = columnsToUpdate
        .map(col => `${quoteIdentifier(col)} = EXCLUDED.${quoteIdentifier(col)}`)
        .join(', ');

    const rewritten = `${baseInsert} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${assignments}`;
    return { sql: appendTerminator(rewritten, context.hasTerminator) };
}

async function translateUpdateWithLimit(
    env: Env,
    statement: string,
    loader: TableInfoLoader,
    context: { hasTerminator: boolean }
): Promise<TranslationResponse> {
    const limitMatch = /\sLIMIT\s+([^\s]+)\s*$/i.exec(statement);
    if (!limitMatch) {
        return null;
    }

    if (!/^UPDATE\s+/i.test(statement)) {
        return null;
    }

    if (/\bRETURNING\b/i.test(statement)) {
        return { skip: 'UPDATE ... LIMIT with RETURNING is not supported' };
    }

    const limitExpr = limitMatch[1];
    const beforeLimit = statement.slice(0, limitMatch.index).trim();

    const upper = beforeLimit.toUpperCase();
    const setIndex = upper.indexOf(' SET ');
    if (setIndex === -1) {
        return { skip: 'Unable to locate SET clause for UPDATE ... LIMIT' };
    }

    const tableSegment = beforeLimit.slice('UPDATE '.length, setIndex).trim();
    if (!tableSegment || /\s/.test(tableSegment)) {
        return { skip: 'UPDATE ... LIMIT with table aliases is not supported' };
    }

    const setAndWhere = beforeLimit.slice(setIndex + 5).trim();
    if (!setAndWhere) {
        return { skip: 'Empty SET clause for UPDATE ... LIMIT' };
    }

    const whereIndex = setAndWhere.toUpperCase().indexOf(' WHERE ');
    const setClause = whereIndex === -1 ? setAndWhere : setAndWhere.slice(0, whereIndex).trim();
    const whereClause = whereIndex === -1 ? '' : setAndWhere.slice(whereIndex + 7).trim();

    const normalizedTableName = normalizeTableName(tableSegment);
    const tableInfo = await fetchTableInfo(env, normalizedTableName, loader);
    if (!tableInfo || tableInfo.length === 0) {
        return { skip: `Missing table metadata for ${normalizedTableName}` };
    }

    const primaryKeys = tableInfo
        .filter(col => Number(col.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map(col => col.name);

    if (primaryKeys.length === 0) {
        return { skip: `Table ${normalizedTableName} has no primary key to use as conflict target` };
    }

    const selectColumns = primaryKeys.map(col => quoteIdentifier(col)).join(', ');
    const limitedSelect = `SELECT ${selectColumns} FROM ${tableSegment}${whereClause ? ` WHERE ${whereClause}` : ''} LIMIT ${limitExpr}`;

    const joinConditions = primaryKeys
        .map(col => `${tableSegment}.${quoteIdentifier(col)} = limited.${quoteIdentifier(col)}`)
        .join(' AND ');

    const rewritten = `WITH limited AS (${limitedSelect}) UPDATE ${tableSegment} SET ${setClause} FROM limited WHERE ${joinConditions}`;
    return { sql: appendTerminator(rewritten, context.hasTerminator) };
}

async function translateDeleteWithLimit(
    env: Env,
    statement: string,
    loader: TableInfoLoader,
    context: { hasTerminator: boolean }
): Promise<TranslationResponse> {
    const limitMatch = /\sLIMIT\s+([^\s]+)\s*$/i.exec(statement);
    if (!limitMatch) {
        return null;
    }

    if (!/^DELETE\s+FROM\s+/i.test(statement)) {
        return null;
    }

    if (/\bRETURNING\b/i.test(statement)) {
        return { skip: 'DELETE ... LIMIT with RETURNING is not supported' };
    }

    const limitExpr = limitMatch[1];
    const beforeLimit = statement.slice(0, limitMatch.index).trim();

    const deleteMatch = /^DELETE\s+FROM\s+([^\s]+)\s*(?:WHERE\s+([\s\S]*))?$/i.exec(beforeLimit);
    if (!deleteMatch) {
        return { skip: 'Unable to parse DELETE ... LIMIT statement' };
    }

    const tableSegment = deleteMatch[1].trim();
    if (!tableSegment || /\s/.test(tableSegment)) {
        return { skip: 'DELETE ... LIMIT with table aliases is not supported' };
    }

    const whereClause = deleteMatch[2]?.trim() ?? '';
    if (/\bORDER\s+BY\b/i.test(whereClause)) {
        return { skip: 'DELETE ... LIMIT with ORDER BY is not supported' };
    }

    const normalizedTableName = normalizeTableName(tableSegment);
    const tableInfo = await fetchTableInfo(env, normalizedTableName, loader);
    if (!tableInfo || tableInfo.length === 0) {
        return { skip: `Missing table metadata for ${normalizedTableName}` };
    }

    const primaryKeys = tableInfo
        .filter(col => Number(col.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map(col => col.name);

    if (primaryKeys.length === 0) {
        return { skip: `Table ${normalizedTableName} has no primary key to use as conflict target` };
    }

    const selectColumns = primaryKeys.map(col => quoteIdentifier(col)).join(', ');
    const limitedSelect = `SELECT ${selectColumns} FROM ${tableSegment}${whereClause ? ` WHERE ${whereClause}` : ''} LIMIT ${limitExpr}`;

    const joinConditions = primaryKeys
        .map(col => `${tableSegment}.${quoteIdentifier(col)} = limited.${quoteIdentifier(col)}`)
        .join(' AND ');

    const rewritten = `WITH limited AS (${limitedSelect}) DELETE FROM ${tableSegment} USING limited WHERE ${joinConditions}`;
    return { sql: appendTerminator(rewritten, context.hasTerminator) };
}

async function fetchTableInfo(env: Env, tableName: string, loader: TableInfoLoader): Promise<TableInfoRow[]> {
    const key = tableName.toLowerCase();
    if (!tableInfoCache.has(key)) {
        try {
            const info = await loader(env, tableName);
            tableInfoCache.set(key, info.map(col => ({ name: col.name, pk: Number(col.pk) })));
        } catch (error) {
            return [];
        }
    }

    return tableInfoCache.get(key) ?? [];
}

function parseColumnList(rawColumnList: string | undefined, tableInfo: TableInfoRow[]): string[] {
    if (rawColumnList && rawColumnList.trim().length > 0) {
        return rawColumnList
            .split(',')
            .map(col => normalizeIdentifier(col))
            .filter(col => col.length > 0);
    }

    return tableInfo.map(col => col.name);
}

function normalizeStatement(sql: string): { statement: string; hasTerminator: boolean } {
    const trimmed = sql.trim();
    const hasTerminator = /;\s*$/.test(trimmed);
    const statement = hasTerminator ? trimmed.replace(/;\s*$/, '') : trimmed;
    return { statement, hasTerminator };
}

function appendTerminator(statement: string, hadTerminator: boolean): string {
    const trimmed = statement.trim();
    return hadTerminator ? `${trimmed};` : trimmed;
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function normalizeTableName(tableRef: string): string {
    const withoutSchema = tableRef.split('.').pop() ?? tableRef;
    return normalizeIdentifier(withoutSchema);
}

function normalizeIdentifier(identifier: string): string {
    let value = identifier.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('`') && value.endsWith('`')) || (value.startsWith('[') && value.endsWith(']'))) {
        value = value.slice(1, -1);
    }
    return value.replace(/""/g, '"');
}

function quoteIdentifier(identifier: string): string {
    const name = normalizeIdentifier(identifier);
    return `"${name.replace(/"/g, '""')}"`;
}
