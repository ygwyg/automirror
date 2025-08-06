#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { convertD1ToPostgres, generateMigrationScript } from './schema-helper';

interface MigrationConfig {
    d1DatabaseId?: string;
    hyperdriveId?: string;
    queueName?: string;
    schemaFile?: string;
}

function updateWranglerToml(config: MigrationConfig) {
    let wranglerContent = readFileSync('wrangler.toml', 'utf8');

    if (config.d1DatabaseId) {
        wranglerContent = wranglerContent.replace(
            /database_id = "your-d1-database-id"/,
            `database_id = "${config.d1DatabaseId}"`
        );
    }

    if (config.hyperdriveId) {
        wranglerContent = wranglerContent.replace(
            /id = "your-hyperdrive-binding-id"/,
            `id = "${config.hyperdriveId}"`
        );
    }

    if (config.queueName) {
        wranglerContent = wranglerContent.replace(
            /queue = "mirror-writes"/g,
            `queue = "${config.queueName}"`
        );
    }

    writeFileSync('wrangler.toml', wranglerContent);
    console.log('✅ Updated wrangler.toml with your configuration');
}

function generatePostgresSchema(schemaFile: string) {
    const d1Schema = readFileSync(schemaFile, 'utf8');
    const { postgresSchema, migrationInstructions } = generateMigrationScript(d1Schema);

    const outputFile = schemaFile.replace('.sql', '-postgres.sql');
    writeFileSync(outputFile, migrationInstructions);

    console.log(`✅ Generated Postgres schema: ${outputFile}`);
    console.log('\n📋 Next steps:');
    console.log('1. Run the generated Postgres schema in your database');
    console.log('2. If you have existing D1 data, export and import it');
    console.log('3. Start with: npm run dev');
    console.log('4. Test the migration with your API calls');
}

// Simple CLI argument parsing
const args = process.argv.slice(2);
const config: MigrationConfig = {};

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--d1-id':
            config.d1DatabaseId = args[++i];
            break;
        case '--hyperdrive-id':
            config.hyperdriveId = args[++i];
            break;
        case '--queue':
            config.queueName = args[++i];
            break;
        case '--schema':
            config.schemaFile = args[++i];
            break;
        case '--help':
            console.log(`
Usage: npm run setup-migration [options]

Options:
  --d1-id <id>         Your D1 database ID
  --hyperdrive-id <id> Your Hyperdrive connection ID  
  --queue <name>       Queue name (default: mirror-writes)
  --schema <file>      Path to your D1 schema file
  --help               Show this help

Example:
  npm run setup-migration --d1-id abc123 --hyperdrive-id def456 --schema src/my-schema.sql
      `);
            process.exit(0);
    }
}

// Update wrangler.toml if IDs provided
if (config.d1DatabaseId || config.hyperdriveId || config.queueName) {
    updateWranglerToml(config);
}

// Generate Postgres schema if schema file provided
if (config.schemaFile) {
    generatePostgresSchema(config.schemaFile);
} 