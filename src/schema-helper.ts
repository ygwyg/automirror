import { TableColumn, quoteIdentifier } from './sql-utils';

/**
 * Schema conversion utilities for D1 to Postgres migration
 */

export function convertD1ToPostgres(d1Sql: string): string {
    let pgSql = d1Sql;

    // Convert AUTOINCREMENT to SERIAL
    pgSql = pgSql.replace(
        /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,
        'SERIAL PRIMARY KEY'
    );

    // Convert unixepoch() to extract(epoch from now())
    pgSql = pgSql.replace(
        /unixepoch\(\)/gi,
        'extract(epoch from now())'
    );

    // Convert SQLite BOOLEAN to Postgres BOOLEAN
    pgSql = pgSql.replace(/INTEGER\s+CHECK\s*\([^)]*\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/gi, 'BOOLEAN');

    // Convert TEXT to VARCHAR for better Postgres compatibility
    pgSql = pgSql.replace(/\bTEXT\b/gi, 'TEXT');

    return pgSql;
}

export function generateMigrationScript(d1Schema: string): {
    postgresSchema: string;
    migrationInstructions: string;
} {
    const postgresSchema = convertD1ToPostgres(d1Schema);

    const migrationInstructions = `
-- Migration Instructions
-- 1. Run this schema in your Postgres database first
-- 2. If you have existing D1 data, export and import it to Postgres
-- 3. Start the worker with PRIMARY_DB="d1" to begin mirroring
-- 4. Verify data consistency between both databases
-- 5. Switch to PRIMARY_DB="pg" when ready

${postgresSchema}
  `.trim();

    return {
        postgresSchema,
        migrationInstructions
    };
}

export function convertD1SchemaToPostgres(schema: Record<string, TableColumn[]>): string {
    const tables = Object.keys(schema);
    const migrationScript: string[] = [];

    migrationScript.push('-- Auto-generated Postgres migration script');
    migrationScript.push('-- Generated from D1 database schema');
    migrationScript.push(`-- Date: ${new Date().toISOString()}`);
    migrationScript.push('');
    migrationScript.push('-- Migration Instructions:');
    migrationScript.push('-- 1. Review this script and adjust data types as needed');
    migrationScript.push('-- 2. Run this script in your Postgres database');
    migrationScript.push('-- 3. Export existing data from D1 using /export endpoint');
    migrationScript.push('-- 4. Import the exported data to Postgres');
    migrationScript.push('-- 5. Start with PRIMARY_DB="d1" to begin mirroring');
    migrationScript.push('-- 6. Verify data consistency, then switch to PRIMARY_DB="pg"');
    migrationScript.push('');

    for (const tableName of tables) {
        const columns = schema[tableName];
        migrationScript.push(`-- Table: ${tableName}`);
        migrationScript.push(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (`);

        const columnDefinitions: string[] = [];
        const primaryKeys: { name: string; order: number }[] = [];

        for (const column of columns) {
            const { name, type, notnull, dflt_value, pk } = column;

            let pgType = convertSqliteTypeToPostgres(type ?? 'TEXT');
            let columnDef = `  ${quoteIdentifier(name)} ${pgType}`;

            // Handle NOT NULL
            if (notnull) {
                columnDef += ' NOT NULL';
            }

            // Handle default values
            if (dflt_value !== null && dflt_value !== undefined) {
                let defaultValue: string;

                if (typeof dflt_value === 'string') {
                    const trimmed = dflt_value.trim();
                    if (trimmed.toUpperCase() === 'CURRENT_TIMESTAMP') {
                        defaultValue = 'CURRENT_TIMESTAMP';
                    } else if (/unixepoch\(\)/i.test(trimmed)) {
                        defaultValue = 'extract(epoch from now())';
                    } else if (!trimmed.includes('(')) {
                        defaultValue = `'${escapeSingleQuotes(trimmed)}'`;
                    } else {
                        defaultValue = trimmed;
                    }
                } else if (typeof dflt_value === 'number' || typeof dflt_value === 'bigint') {
                    defaultValue = dflt_value.toString();
                } else if (typeof dflt_value === 'boolean') {
                    defaultValue = dflt_value ? 'TRUE' : 'FALSE';
                } else {
                    defaultValue = `'${escapeSingleQuotes(JSON.stringify(dflt_value))}'::jsonb`;
                }

                columnDef += ` DEFAULT ${defaultValue}`;
            }

            columnDefinitions.push(columnDef);

            // Track primary keys
            if (pk) {
                primaryKeys.push({ name, order: pk });
            }
        }

        // Add primary key constraint if exists
        if (primaryKeys.length > 0) {
            const sortedKeys = primaryKeys
                .sort((a, b) => a.order - b.order)
                .map(key => quoteIdentifier(key.name));
            columnDefinitions.push(`  PRIMARY KEY (${sortedKeys.join(', ')})`);
        }

        migrationScript.push(columnDefinitions.join(',\n'));
        migrationScript.push(');');
        migrationScript.push('');
    }

    migrationScript.push('-- Indexes (you may want to add additional indexes based on your queries)');
    for (const tableName of tables) {
        const columns = schema[tableName];

        // Create index on primary key columns (if not already primary key)
        const nonPkColumns = columns.filter(col => !col.pk && (col.name.includes('id') || col.name.includes('_id')));
        for (const column of nonPkColumns) {
            migrationScript.push(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${tableName}_${column.name}`)} ON ${quoteIdentifier(tableName)}(${quoteIdentifier(column.name)});`);
        }
    }

    migrationScript.push('');
    migrationScript.push('-- Migration complete!');
    migrationScript.push('-- Next steps:');
    migrationScript.push('-- 1. Export your D1 data: GET /export?table=<tablename>');
    migrationScript.push('-- 2. Import to Postgres');
    migrationScript.push('-- 3. Start mirroring with PRIMARY_DB="d1"');

    return migrationScript.join('\n');
}

function convertSqliteTypeToPostgres(sqliteType: string): string {
    const type = sqliteType.toUpperCase();

    // Handle common SQLite to Postgres type mappings
    if (type.includes('INTEGER')) {
        if (type.includes('PRIMARY KEY') && type.includes('AUTOINCREMENT')) {
            return 'SERIAL';
        }
        return 'INTEGER';
    }

    if (type.includes('TEXT')) {
        return 'TEXT';
    }

    if (type.includes('REAL') || type.includes('DOUBLE') || type.includes('FLOAT')) {
        return 'DOUBLE PRECISION';
    }

    if (type.includes('NUMERIC') || type.includes('DECIMAL')) {
        return 'NUMERIC';
    }

    if (type.includes('BOOLEAN') || type.includes('BOOL')) {
        return 'BOOLEAN';
    }

    if (type.includes('DATE')) {
        return 'DATE';
    }

    if (type.includes('TIME')) {
        return 'TIMESTAMP';
    }

    if (type.includes('BLOB')) {
        return 'BYTEA';
    }

    // Default to TEXT for unknown types
    return 'TEXT';
}

function escapeSingleQuotes(value: string): string {
    return value.replace(/'/g, "''");
}