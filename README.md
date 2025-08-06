# D1 to Postgres Migration Framework

> ⚠️ **ALPHA VERSION** - This is an early release for testing and feedback. Not recommended for production use without thorough testing. Please report issues and contribute improvements!

A progressive migration system for Cloudflare Workers that allows you to migrate from D1 to Postgres without downtime. As the name states it automatically mirrors writes from D1 to Postgres, then allows you to switch the primary database when ready.

## Features

- Progressive migration path from D1 to Postgres
- Automatic write mirroring using Cloudflare Queues
- Configurable primary database switching
- Built-in conflict resolution with operation IDs
- Streaming data export for existing D1 data

## Prerequisites

You'll need the following resources:

- Cloudflare account with Workers enabled
- D1 database created in your Cloudflare dashboard
- Postgres database accessible from the internet
- Hyperdrive connection configured for your Postgres database
- Cloudflare Queue for async mirroring
- Node.js 18 or later
- Wrangler CLI (`npm install -g wrangler`)

## Alpha Deployment Checklist

Before deploying this alpha version, make sure you have:

- [ ] **Created D1 Database**: Run `npm run db:create` and note the database ID
- [ ] **Created Queue**: Run `npm run queue:create` 
- [ ] **Setup Hyperdrive**: Create connection in Cloudflare Dashboard for your Postgres
- [ ] **Updated wrangler.toml**: Replace placeholder IDs with your actual resource IDs
- [ ] **Initialized Schemas**: Run database migrations for both D1 and Postgres
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

Create your D1 database:
```bash
npm run db:create
```

Create the queue:
```bash
npm run queue:create
```

Create a Hyperdrive connection:
1. Navigate to Cloudflare Dashboard → Hyperdrive
2. Create a new connection using your Postgres database details
3. Copy the generated Hyperdrive ID

### 4. Configure Resources

Edit `wrangler.toml` and replace the placeholder values:

```toml
[[d1_databases]]
binding = "DB"
database_name = "auto-mirror-db"
database_id = "YOUR_ACTUAL_D1_DATABASE_ID"  # Get from: wrangler d1 list

[[hyperdrive]]
binding = "PG"
id = "YOUR_HYPERDRIVE_ID"  # From Cloudflare dashboard

[[queues.producers]]
binding = "MIRROR_QUEUE"
queue = "mirror-writes"
```

### 5. Initialize Database Schema

For D1:
```bash
# For local development
npm run db:migrate-local

# For production
npm run db:migrate
```

For Postgres - Run this schema in your Postgres database:
```sql
CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT extract(epoch from now()),
  op_id TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS notes_op_id_idx ON notes(op_id);
```

### 6. Export Existing Data (If Any)

If you have existing data in D1, export it first:

```bash
# Start the worker
npm run dev

# Export each table (in another terminal)
curl "http://localhost:8787/export?table=your_table_name" > your_table_export.sql

# Import to Postgres
psql your_postgres_db < your_table_export.sql
```

### 7. Start Development

```bash
npm run dev
```

## Testing the API

Create a note:
```bash
curl -X POST http://localhost:8787/notes \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Note","content":"This is a test note"}'
```

Retrieve all notes:
```bash
curl http://localhost:8787/notes
```

Verify data appears in both D1 and Postgres databases.

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
│   Client App    │───▶│    Worker    │───▶│   D1 Database   │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────┐    ┌─────────────────┐
                       │  SQL Mirror  │───▶│    Postgres     │
                       └──────────────┘    └─────────────────┘

```

### Components

- **AutoMirrorDB**: Patches the D1 client to automatically queue writes for mirroring
- **DB Router**: Routes read/write operations based on the PRIMARY_DB configuration
- **Queue Consumer**: Processes queued write operations to Postgres
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
> - Basic schema conversion (missing complex constraints)
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
Look for failed queue messages, verify `op_id` uniqueness constraints are working, and review error logs for transaction failures.

### Getting Help

1. Check worker logs: `wrangler tail`
2. Verify all IDs in `wrangler.toml` are correct
3. Test each component individually
4. Review Cloudflare Dashboard for resource status

## API Reference

### POST /notes
Create a new note.

**Request:**
```json
{
  "title": "Note Title",
  "content": "Note content here"
}
```

**Response:**
```json
{
  "opId": "uuid-generated-operation-id"
}
```

### GET /notes
Retrieve all notes (ordered by newest first).

**Response:**
```json
[
  {
    "id": 1,
    "title": "Note Title",
    "content": "Note content",
    "created_at": 1703123456,
    "op_id": "uuid-operation-id"
  }
]
```

### GET /export
Export data from D1 for migration.

**Parameters:**
- `table` - Table name to export
- `format` - `sql` (default) or `json`
- `batchSize` - Rows per batch (default: 1000)

**Examples:**
```bash
# Export as SQL
curl "http://localhost:8787/export?table=notes" > notes_export.sql

# Export as JSON
curl "http://localhost:8787/export?table=notes&format=json" > notes_export.json

# List all tables
curl "http://localhost:8787/export"
```

## Contributing

This is an alpha release - contributions and feedback are very welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License 