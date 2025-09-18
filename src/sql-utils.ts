export interface TableColumn {
    name: string;
    type?: string;
    notnull?: number | boolean;
    dflt_value?: unknown;
    pk?: number;
}

export function quoteIdentifier(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

export function deriveOrderingColumns(schema?: TableColumn[]): string[] {
    if (schema && schema.length > 0) {
        const primaryKeys = schema
            .filter(column => typeof column.pk === 'number' && column.pk > 0)
            .sort((a, b) => (a.pk ?? 0) - (b.pk ?? 0))
            .map(column => column.name)
            .filter(Boolean);

        if (primaryKeys.length > 0) {
            return primaryKeys;
        }

        return [schema[0].name];
    }

    return ['rowid'];
}

export function normalizeParams(args: unknown[]): unknown[] {
    if (args.length === 0) {
        return [];
    }

    if (args.length === 1 && Array.isArray(args[0])) {
        return [...args[0]];
    }

    return [...args];
}

export function convertSqlitePlaceholdersToPostgres(sql: string): string {
    const explicitIndexes = new Set<number>();
    let nextIndex = 1;

    const getNextIndex = () => {
        while (explicitIndexes.has(nextIndex)) {
            nextIndex += 1;
        }
        const value = nextIndex;
        nextIndex += 1;
        return value;
    };

    return sql.replace(/\?(\d+)?/g, (_match, explicit) => {
        if (explicit) {
            const index = Number(explicit);
            explicitIndexes.add(index);
            return `$${index}`;
        }
        const index = getNextIndex();
        return `$${index}`;
    });
}

export function formatPostgresValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return 'NULL';
        }
        return value.toString();
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value === 'boolean') {
        return value ? 'TRUE' : 'FALSE';
    }

    if (value instanceof Date) {
        return `'${value.toISOString()}'`;
    }

    if (value instanceof ArrayBuffer) {
        return `'\\x${toHex(new Uint8Array(value))}'::bytea`;
    }

    if (value instanceof Uint8Array) {
        return `'\\x${toHex(value)}'::bytea`;
    }

    if (Array.isArray(value)) {
        return `'${escapeSingleQuotes(JSON.stringify(value))}'::jsonb`;
    }

    if (typeof value === 'object') {
        return `'${escapeSingleQuotes(JSON.stringify(value))}'::jsonb`;
    }

    return `'${escapeSingleQuotes(String(value))}'`;
}

function toHex(bytes: Uint8Array): string {
    let result = '';
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, '0');
    }
    return result;
}

function escapeSingleQuotes(value: string): string {
    return value.replace(/'/g, "''");
}
