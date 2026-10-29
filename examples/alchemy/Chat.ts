// An Effect-native Durable Object, wrapped with the Alchemy adapter.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Migrator from "@rivet-dev/durable-object-migrator/alchemy";

export default class Chat extends Cloudflare.DurableObject<Chat>()(
	"Chat",
	Migrator.migratable(
		Effect.gen(function* () {
			const state = yield* Cloudflare.DurableObjectState;
			return Effect.gen(function* () {
				const sql = state.storage.sql;
				yield* sql.exec(`CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, text TEXT)`).pipe(Effect.orDie);
				return {
					addMessage: Effect.fn("Chat.addMessage")(function* (text: string) {
						yield* sql.exec(`INSERT INTO messages(text) VALUES (?)`, text).pipe(Effect.orDie);
					}),
				};
			});
		}),
	),
) {}
