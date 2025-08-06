import { Env } from './worker';
import { streamTableData, getAllTables, getTableSchema, generatePostgresInserts } from './export-helper';

/**
 * Export endpoint that streams D1 data as Postgres INSERT statements
 */
export async function handleExport(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const tableName = url.searchParams.get('table');
    const format = url.searchParams.get('format') || 'sql'; // 'sql' or 'json'
    const batchSize = parseInt(url.searchParams.get('batchSize') || '1000');

    // If no table specified, return list of tables
    if (!tableName) {
        const tables = await getAllTables(env);
        return Response.json({
            tables,
            usage: {
                listTables: '?',
                exportTable: '?table=tablename',
                exportAsJson: '?table=tablename&format=json',
                customBatch: '?table=tablename&batchSize=500'
            }
        });
    }

    try {
        const schema = await getTableSchema(env, tableName);

        if (format === 'json') {
            return streamJsonExport(env, tableName, batchSize, schema);
        } else {
            return streamSqlExport(env, tableName, batchSize, schema);
        }
    } catch (error) {
        return new Response(`Export error: ${error}`, { status: 500 });
    }
}

async function streamSqlExport(env: Env, tableName: string, batchSize: number, schema: any[]) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            // Send header comment
            const header = `-- Export of table: ${tableName}\n-- Generated: ${new Date().toISOString()}\n\n`;
            controller.enqueue(encoder.encode(header));

            try {
                for await (const batch of streamTableData(env, { tableName, batchSize })) {
                    const inserts = generatePostgresInserts(tableName, batch.rows, schema);
                    const sql = inserts.join('\n') + '\n\n';
                    controller.enqueue(encoder.encode(sql));

                    // Add a small comment for progress tracking
                    const progress = `-- Batch ${batch.batchNumber} (${batch.rows.length} rows)\n`;
                    controller.enqueue(encoder.encode(progress));
                }

                controller.enqueue(encoder.encode('-- Export completed\n'));
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${tableName}_export.sql"`
        }
    });
}

async function streamJsonExport(env: Env, tableName: string, batchSize: number, schema: any[]) {
    const encoder = new TextEncoder();
    let isFirst = true;

    const stream = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode('{\n'));
            controller.enqueue(encoder.encode(`  "table": "${tableName}",\n`));
            controller.enqueue(encoder.encode(`  "exported": "${new Date().toISOString()}",\n`));
            controller.enqueue(encoder.encode('  "schema": '));
            controller.enqueue(encoder.encode(JSON.stringify(schema, null, 2)));
            controller.enqueue(encoder.encode(',\n  "data": [\n'));

            try {
                for await (const batch of streamTableData(env, { tableName, batchSize })) {
                    for (const row of batch.rows) {
                        if (!isFirst) {
                            controller.enqueue(encoder.encode(',\n'));
                        }
                        controller.enqueue(encoder.encode('    ' + JSON.stringify(row)));
                        isFirst = false;
                    }
                }

                controller.enqueue(encoder.encode('\n  ]\n}'));
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${tableName}_export.json"`
        }
    });
} 