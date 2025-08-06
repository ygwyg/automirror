# D1 to Postgres Migration Framework

> ⚠️ **ALPHA VERSION** - This is an early release for testing and feedback. Not recommended for production use without thorough testing. Please report issues and contribute improvements!

A progressive migration system for Cloudflare Workers that allows you to migrate from D1 to Postgres without downtime. Works with **any existing D1 database** - automatically discovers your schema and generates the appropriate Postgres migration scripts.

## Features

- **Works with any D1 database** - No need to modify your existing schema
- **Automatic schema discovery** - Infers your D1 table structure and generates Postgres equivalents
- Progressive migration path from D1 to Postgres
- Automatic write mirroring using Cloudflare Queues
- Configurable primary database switching
- Built-in conflict resolution with operation IDs
- Streaming data export for existing D1 data
- **Generic SQL execution** - Execute any SQL query through the API

## Prerequisites

You'll need the following resources:

- Cloudflare account with Workers enabled
- **Existing D1 database** with your data and schema
- Postgres database accessible from the internet
- Hyperdrive connection configured for your Postgres database
- Cloudflare Queue for async mirroring
- Node.js 18 or later
- Wrangler CLI (`npm install -g wrangler`)

## Alpha Deployment Checklist

Before deploying this alpha version, make sure you have:

- [ ] **Existing D1 Database**: Use your current D1 database ID in wrangler.toml
- [ ] **Created Queue**: Run `wrangler queues create mirror-writes` 
- [ ] **Setup Hyperdrive**: Create connection in Cloudflare Dashboard for your Postgres
- [ ] **Updated wrangler.toml**: Replace placeholder IDs with your actual resource IDs
- [ ] **Generated Migration Script**: Use `/migration-script` endpoint to create Postgres schema
- [ ] **Setup Postgres Schema**: Run the generated migration script in your Postgres database
- [ ] **Tested Locally**: Verify `npm run dev` works and API endpoints respond
- [ ] **Validated Configuration**: Run `npm run validate` to check D1 setup

**⚠️ Alpha Limitations**: No authentication, basic error handling, limited monitoring. Test thoroughly before any production use.

## Quick Start

### 1. Install Dependencies

```bash
cd d1-auto-mirror-extended
npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create Cloudflare Resources

Create the queue (you should already have a D1 database):
```bash
wrangler queues create mirror-writes
```

Create a Hyperdrive connection:
1. Navigate to Cloudflare Dashboard → Hyperdrive
2. Create a new connection using your Postgres database details
3. Copy the generated Hyperdrive ID

### 4. Configure Resources

Edit `wrangler.toml` and replace the placeholder values with your **existing** D1 database:

```toml
[[d1_databases]]
binding = "DB"
database_name = "your-existing-db-name"
database_id = "YOUR_EXISTING_D1_DATABASE_ID"  # Get from: wrangler d1 list

[[hyperdrive]]
binding = "PG"
id = "YOUR_HYPERDRIVE_ID"  # From Cloudflare dashboard

[[queues.producers]]
binding = "MIRROR_QUEUE"
queue = "mirror-writes"
```

### 5. Generate and Setup Postgres Schema

Start the worker:
```bash
npm run dev
```

In another terminal, generate the Postgres migration script from your D1 schema:
```bash
curl "http://localhost:8787/migration-script" > postgres-migration.sql
```

Review the generated script and run it in your Postgres database:
```bash
psql your_postgres_db < postgres-migration.sql
```

### 6. Export Existing Data

Export your existing D1 data to Postgres:

```bash
# Get list of tables
curl "http://localhost:8787/tables"

# Export each table
curl "http://localhost:8787/export?table=your_table_name" > your_table_export.sql

# Import to Postgres
psql your_postgres_db < your_table_export.sql
```

### 7. Test the Migration

Execute a test query to verify both databases work:
```bash
curl -X POST http://localhost:8787/execute \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT * FROM your_table_name LIMIT 5"}'
```

Verify data appears in both D1 and Postgres databases.

## API Reference

### POST /execute
Execute any SQL query on your database.

**Request:**
```json
{
  "sql": "SELECT * FROM users WHERE active = ?",
  "params": [true]
}
```

**Response:**
```json
{
  "success": true,
  "results": [...],
  "meta": {
    "changes": 0,
    "rows_read": 5,
    "rows_written": 0
  }
}
```

### GET /schema
Get complete database schema information.

**Response:**
```json
{
  "tables": ["users", "posts", "comments"],
  "schema": {
    "users": [
      {"name": "id", "type": "INTEGER", "pk": 1, "notnull": 1},
      {"name": "email", "type": "TEXT", "pk": 0, "notnull": 1}
    ]
  }
}
```

### GET /tables
Get list of all tables in your database.

**Response:**
```json
{
  "tables": ["users", "posts", "comments"]
}
```

### GET /migration-script
Generate Postgres migration script from your D1 schema.

**Response:** SQL file download with CREATE TABLE statements

### GET /export
Export data from D1 for migration.

**Parameters:**
- `table` - Table name to export
- `format` - `sql` (default) or `json`
- `batchSize` - Rows per batch (default: 1000)

**Examples:**
```bash
# Export as SQL
curl "http://localhost:8787/export?table=users" > users_export.sql

# Export as JSON
curl "http://localhost:8787/export?table=users&format=json" > users_export.json

# List all tables
curl "http://localhost:8787/export"
```

## Migration Process

### Phase 1: D1 Primary (Default)
```toml
[vars]
PRIMARY_DB = "d1"
```
- All reads from D1
- All writes to D1 + async mirror to Postgres via Queue
- Postgres builds up identical dataset

### Phase 2: Switch to Postgres Primary
```toml
[vars]
PRIMARY_DB = "pg"
```
- All reads from Postgres
- All writes to Postgres + sync write to D1
- D1 becomes backup/fallback

### Phase 3: Postgres Only
Once you're confident in the Postgres setup, you can remove the D1 logic entirely.

## Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Your App      │───▶│    Worker    │───▶│   D1 Database   │
│   (Any Schema)  │    │   (Generic)  │    │  (Your Tables)  │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────┐    ┌─────────────────┐
                       │  SQL Mirror  │───▶│    Postgres     │
                       │   (Queue)    │    │ (Mirrored Data) │
                       └──────────────┘    └─────────────────┘

```

### Components

- **AutoMirrorDB**: Patches the D1 client to automatically queue writes for mirroring
- **Generic DB Router**: Routes any SQL operation based on the PRIMARY_DB configuration
- **Queue Consumer**: Processes queued write operations to Postgres
- **Schema Discovery**: Automatically infers D1 schema and generates Postgres equivalents
- **Export System**: Streams existing D1 data for migration

## Configuration Variables

- `PRIMARY_DB`: Set to `"d1"` or `"pg"` to determine which database handles reads
- `PG_DSN`: Direct Postgres connection string (can be used instead of Hyperdrive for local dev)

## Deployment

```bash
npm run deploy
```

## Alpha Version Limitations

> ⚠️ **Known Issues & Limitations:**
> - No authentication/authorization on API endpoints
> - Limited error handling and retry logic
> - No rate limiting or abuse protection
> - Basic schema conversion (may need manual adjustment for complex schemas)
> - No monitoring/observability built-in
> - Connection pooling not optimized for high traffic

**Before using in production:**
1. Add proper authentication to your endpoints
2. Implement comprehensive error handling
3. Add monitoring and alerting
4. Test thoroughly with your specific use case
5. Plan rollback procedures

## Troubleshooting

### Common Issues

**Database not found error:**
Verify the database ID in `wrangler.toml` matches your actual D1 database. List your databases with `wrangler d1 list` to confirm.

**Hyperdrive connection failures:**
Ensure your Postgres database is accessible from the internet, verify the connection string format, and test the connection through the Cloudflare Dashboard.

**Queue not processing messages:**
Check that the queue name in `wrangler.toml` matches your actual queue, and monitor worker logs with `wrangler tail` for errors.

**Data inconsistency between databases:**
Look for failed queue messages, verify operation IDs are working, and review error logs for transaction failures.

**Schema conversion issues:**
The auto-generated migration script may need manual adjustments for complex schemas. Review the generated SQL before running it.

### Getting Help

1. Check worker logs: `wrangler tail`
2. Verify all IDs in `wrangler.toml` are correct
3. Test each component individually
4. Review Cloudflare Dashboard for resource status
5. Use `/schema` endpoint to verify schema detection

## Contributing

This is an alpha release - contributions and feedback are very welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License 