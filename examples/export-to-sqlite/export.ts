// Moves one Durable Object into a local .sqlite file.
//
//   WORKER_URL=https://my-app.<subdomain>.workers.dev WORKER_MIGRATOR_TOKEN=... \
//   node --experimental-transform-types export.ts ROOMS lobby
//
// After this runs, the Durable Object on Cloudflare rejects app traffic.

import { rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createClient, MigrationDirtyError } from "../../src/client.ts";

const [binding, name] = process.argv.slice(2);
if (!binding || !name) throw new Error("usage: export.ts <BINDING> <name>");

const migrator = createClient({
	workerUrl: required("WORKER_URL"),
	token: required("WORKER_MIGRATOR_TOKEN"),
});

const { id } = await migrator.resolve(binding, { name });
const path = `${name}.sqlite`;

for (let attempt = 1; ; attempt++) {
	try {
		await exportTo(id, path);
		break;
	} catch (err) {
		// The object was written to during the export. Start over.
		if (err instanceof MigrationDirtyError && attempt < 5) continue;
		throw err;
	}
}
console.log(`wrote ${path}`);

async function exportTo(id: string, path: string) {
	// Written to a temporary file, so a failed export never leaves a half-written database.
	const partial = `${path}.partial`;
	await rm(partial, { force: true });
	const db = new DatabaseSync(partial, { enableForeignKeyConstraints: false });
	try {
		try {
			for await (const page of migrator.exportObject({ binding: binding!, id })) db.exec(page.sql);
		} finally {
			db.close();
		}
		await rename(partial, path);
	} catch (err) {
		await rm(partial, { force: true });
		throw err;
	}
}

function required(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is not set`);
	return value;
}
