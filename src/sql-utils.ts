export type PlaceholderMappingEntry =
    | { kind: 'positional'; index: number }
    | { kind: 'numbered'; index: number }
    | { kind: 'named'; name: string; token: string };

export interface ConvertedSql {
    sql: string;
    mapping: PlaceholderMappingEntry[];
}

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_]/;
const digit = /[0-9]/;

function isIdentifierStart(char: string | undefined): char is string {
    return !!char && identifierStart.test(char);
}

function isIdentifierPart(char: string | undefined): char is string {
    return !!char && identifierPart.test(char);
}

function isDigit(char: string | undefined): char is string {
    return !!char && digit.test(char);
}

function isPlaceholderPrefix(char: string): boolean {
    return char === ':' || char === '@' || char === '$';
}

export function convertSqlitePlaceholdersToPostgres(sql: string): ConvertedSql {
    const mapping: PlaceholderMappingEntry[] = [];
    const placeholderIndexByKey = new Map<string, number>();
    let positionalCounter = 0;
    let result = '';
    const length = sql.length;

    const getIndex = (key: string, entryFactory: () => PlaceholderMappingEntry): number => {
        const existing = placeholderIndexByKey.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const index = mapping.length + 1;
        placeholderIndexByKey.set(key, index);
        mapping.push(entryFactory());
        return index;
    };

    let i = 0;
    while (i < length) {
        const char = sql[i];

        if (char === '-' && i + 1 < length && sql[i + 1] === '-') {
            result += '--';
            i += 2;
            while (i < length) {
                const current = sql[i];
                result += current;
                if (current === '\n') {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (char === '/' && i + 1 < length && sql[i + 1] === '*') {
            result += '/*';
            i += 2;
            while (i < length) {
                const current = sql[i];
                if (current === '*' && i + 1 < length && sql[i + 1] === '/') {
                    result += '*/';
                    i += 2;
                    break;
                }
                result += current;
                i++;
            }
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            result += char;
            i++;
            while (i < length) {
                const current = sql[i];
                result += current;
                if (current === char) {
                    if ((char === '\'' || char === '"') && i + 1 < length && sql[i + 1] === char) {
                        result += sql[i + 1];
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (char === '[') {
            result += char;
            i++;
            while (i < length) {
                const current = sql[i];
                result += current;
                if (current === ']') {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (char === '?') {
            let j = i + 1;
            while (j < length && isDigit(sql[j])) {
                j++;
            }
            const digits = sql.slice(i + 1, j);
            if (digits.length > 0) {
                const numericIndex = Math.max(parseInt(digits, 10) - 1, 0);
                const placeholderIndex = getIndex(`numbered-${numericIndex}`, () => ({
                    kind: 'numbered',
                    index: numericIndex,
                }));
                result += `$${placeholderIndex}`;
            } else {
                const positionalIndex = positionalCounter++;
                const placeholderIndex = getIndex(`positional-${positionalIndex}`, () => ({
                    kind: 'positional',
                    index: positionalIndex,
                }));
                result += `$${placeholderIndex}`;
            }
            i = j;
            continue;
        }

        if ((char === ':' || char === '@' || char === '$') && isIdentifierStart(sql[i + 1])) {
            let j = i + 2;
            while (j < length && isIdentifierPart(sql[j])) {
                j++;
            }
            const name = sql.slice(i + 1, j);
            const token = sql.slice(i, j);
            const placeholderIndex = getIndex(`named-${name}`, () => ({
                kind: 'named',
                name,
                token,
            }));
            result += `$${placeholderIndex}`;
            i = j;
            continue;
        }

        result += char;
        i++;
    }

    return { sql: result, mapping };
}

export function normalizeNamedBindings(source: Map<string, unknown>, key: string, value: unknown) {
    source.set(key, value);
    if (!key) {
        return;
    }
    if (isPlaceholderPrefix(key[0])) {
        const bare = key.slice(1);
        if (bare) {
            source.set(bare, value);
        }
    } else {
        source.set(`:${key}`, value);
        source.set(`@${key}`, value);
        source.set(`$${key}`, value);
    }
}

export function buildPostgresParameterArray(
    mapping: PlaceholderMappingEntry[],
    positional: unknown[],
    named: Map<string, unknown> = new Map(),
): unknown[] {
    if (mapping.length === 0) {
        return [];
    }

    return mapping.map(entry => {
        switch (entry.kind) {
            case 'positional':
            case 'numbered':
                return positional[entry.index];
            case 'named':
                if (named.has(entry.token)) {
                    return named.get(entry.token);
                }
                return named.get(entry.name);
        }
    });
}
