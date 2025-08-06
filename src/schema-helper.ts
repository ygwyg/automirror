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