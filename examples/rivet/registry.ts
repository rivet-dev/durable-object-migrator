// Moves each Cloudflare Durable Object into a Rivet Actor with the same name.
// server.ts runs these actors. Lazy migration happens when an actor first
// starts. backfill.ts wakes the actors nobody touched.

import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
import { createClient } from "@rivet-dev/durable-object-migrator/client";

export const migrator = createClient({
	workerUrl: required("WORKER_URL"),
	token: required("WORKER_MIGRATOR_TOKEN"),
});

/** Durable Objects with no saved name are keyed `cloudflare:<id>`. */
export const UNNAMED_PREFIX = "cloudflare:";

export const room = actor({
	db: db(),
	// Runs on every start, before the actor serves anything. Only one instance
	// of an actor runs at a time, so lazy migration and backfill cannot import
	// the same Durable Object twice.
	onMigrate: async (c) => {
		const moved = await c.db.execute(`SELECT 1 FROM sqlite_master WHERE name = '__do_meta'`);
		if (moved.length > 0) return;

		const key = c.key[0]!;
		const id = key.startsWith(UNNAMED_PREFIX)
			? key.slice(UNNAMED_PREFIX.length)
			: (await migrator.resolve("ROOMS", { name: key })).id;

		// All or nothing. If the export throws (for example MigrationDirtyError),
		// nothing is kept and the next start tries again.
		await c.db.transaction(async (tx) => {
			// The export can insert a child row before its parent. Foreign keys
			// cannot be turned off inside a transaction, so check them at commit.
			await tx.execute("PRAGMA defer_foreign_keys = ON");
			for await (const page of migrator.exportObject({ binding: "ROOMS", id })) {
				for (const stmt of page.statements) await tx.execute(stmt);
			}
		});
	},
	actions: {
		ping: () => "pong",
	},
});

export const registry = setup({ use: { room } });

function required(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is not set`);
	return value;
}
