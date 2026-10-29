// Both kinds of Durable Object on Alchemy v2, each ready to export.
//
//   Room: a plain class, wrapped with `migratable` from `@rivet-dev/durable-object-migrator/worker`.
//   Chat: an Effect-native object, wrapped with `migratable` from `@rivet-dev/durable-object-migrator/alchemy`.
//
// Set WORKER_MIGRATOR_TOKEN in .env before you deploy. Backfill needs each
// Worker's script name, which is the `workerName` output, not the stack name.
import { join } from "node:path";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import Api from "./Api.ts";

export const Rooms = Cloudflare.DurableObject("Room", { className: "Room" });

// The plain Worker reads its env directly, so the migrator values are declared here.
export const PlainWorker = Cloudflare.Worker("PlainWorker", {
	// Resolved from this file, so the stack deploys from any directory.
	main: join(import.meta.dirname, "plain-worker.ts"),
	compatibility: { date: "2026-07-01" },
	env: {
		ROOMS: Rooms,
		WORKER_MIGRATOR_TOKEN: Config.Redacted("WORKER_MIGRATOR_TOKEN"),
		MIGRATOR_DISABLED: Config.String("MIGRATOR_DISABLED").pipe(Config.withDefault("false")),
	},
});

export default Alchemy.Stack(
	"MigratorExample",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const plain = yield* PlainWorker;
		const api = yield* Api;
		return {
			plain: { url: plain.url.as<string>(), scriptName: plain.workerName },
			api: { url: api.url.as<string>(), scriptName: api.workerName },
		};
	}),
);
