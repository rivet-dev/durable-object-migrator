// An Effect-native Durable Object wrapped with the adapter.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Migrator from "../../src/alchemy.ts";

export default class Room extends Cloudflare.DurableObject<Room>()(
	"Room",
	Migrator.migratable(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			return Effect.gen(function* () {
				const sql = state.storage.sql;
				// A failed statement or schedule here is a bug in the fixture, so it is a defect.
				const exec = (query: string, ...bindings: ReadonlyArray<string>) =>
					sql.exec(query, ...bindings).pipe(Effect.orDie);

				const tick = yield* Alchemy.makeCallback(
					"tick",
					Effect.fn("Room.tick")(function* (body: string) {
						yield* exec(`INSERT INTO notes(body) VALUES (?)`, body);
					}),
				);

				return {
					seed: Effect.fn("Room.seed")(function* (size: "small" | "big") {
						yield* exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, data BLOB)`);
						yield* exec(`INSERT INTO notes(body) VALUES ('hello'), ('it''s ünïcödé')`);
						// Rows near Cloudflare's 2 MB limit force the export over several pages.
						if (size === "big") {
							for (let i = 0; i < 4; i++) yield* exec(`INSERT INTO notes(data) VALUES (randomblob(1500000))`);
						}
					}),
					addNote: Effect.fn("Room.addNote")(function* (body: string) {
						yield* exec(`INSERT INTO notes(body) VALUES (?)`, body);
					}),
					schedule: Effect.fn("Room.schedule")(function* (body: string) {
						yield* tick.schedule("t", { after: "1 hour", payload: body }).pipe(Effect.orDie);
					}),
					fetch: Effect.gen(function* () {
						const cursor = yield* sql.exec<{ n: number }>(`SELECT count(*) AS n FROM notes`).pipe(Effect.orDie);
						const { n } = yield* cursor.one().pipe(Effect.orDie);
						return HttpServerResponse.text(String(n));
					}),
				};
			});
		}),
	),
) {}
