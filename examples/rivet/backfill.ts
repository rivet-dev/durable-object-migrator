// Wakes a Rivet Actor for every Durable Object on Cloudflare. Each actor
// imports its own data in onMigrate (see registry.ts).
//
//   RIVET_ENDPOINT=... WORKER_URL=... WORKER_MIGRATOR_TOKEN=... CF_API_TOKEN=... CF_ACCOUNT_ID=... \
//   node --experimental-transform-types backfill.ts

import { createClient as createRivetClient } from "rivetkit/client";
import { migrator, type registry, UNNAMED_PREFIX } from "./registry.ts";

const rivet = createRivetClient<typeof registry>(process.env.RIVET_ENDPOINT);

const result = await migrator.backfill({
	cloudflare: {
		apiToken: required("CF_API_TOKEN"),
		accountId: required("CF_ACCOUNT_ID"),
		scriptName: "my-app",
		className: "Room",
		// Optional. Points at a stand-in for the Cloudflare API, for example in tests.
		apiUrl: process.env.CF_API_URL,
	},
	// Store this somewhere durable in a real migration.
	startAt: null,
	updateStartAt: () => {},
	// user writes this
	migrate: async ({ id }) => {
		const { name } = await migrator.resolve("ROOMS", { id });
		await rivet.room.getOrCreate([name ?? `${UNNAMED_PREFIX}${id}`]).ping();
	},
});
console.log(result);

function required(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is not set`);
	return value;
}
