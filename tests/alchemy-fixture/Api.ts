// The Worker in front of Room. Each route calls the Durable Object once.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import * as Migrator from "../../src/alchemy.ts";
import Room from "./Room.ts";

const RoomParams = Schema.Struct({ name: Schema.String });
const SeedParams = Schema.Struct({ name: Schema.String, size: Schema.Literals(["small", "big"]) });

export default class Api extends Cloudflare.Worker<Api>()(
	"Api",
	{ main: import.meta.url, compatibility: { date: "2026-07-01" } },
	Effect.gen(function* () {
		const rooms = yield* Room;
		const room = HttpRouter.schemaPathParams(RoomParams).pipe(Effect.map(({ name }) => rooms.getByName(name)));
		const ok = HttpServerResponse.text("ok");

		const routes = HttpRouter.addAll([
			HttpRouter.route(
				"POST",
				"/rooms/:name/seed/:size",
				Effect.gen(function* () {
					const { name, size } = yield* HttpRouter.schemaPathParams(SeedParams);
					yield* rooms.getByName(name).seed(size);
					return ok;
				}),
			),
			HttpRouter.route(
				"POST",
				"/rooms/:name/notes",
				Effect.gen(function* () {
					const body = yield* (yield* HttpServerRequest.HttpServerRequest).text;
					yield* (yield* room).addNote(body);
					return ok;
				}),
			),
			HttpRouter.route(
				"POST",
				"/rooms/:name/schedule",
				Effect.gen(function* () {
					yield* (yield* room).schedule("written by the alarm callback");
					return ok;
				}),
			),
			// Forwards the request to the Durable Object's fetch, which answers with its note count.
			HttpRouter.route(
				"GET",
				"/rooms/:name/count",
				Effect.gen(function* () {
					return yield* (yield* room).fetch(yield* HttpServerRequest.HttpServerRequest);
				}),
			),
		]);

		const app = (yield* HttpRouter.toHttpEffect(routes)).pipe(
			Effect.catchTags({
				SchemaError: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
				MigrationMovedError: (error) =>
					HttpServerResponse.json({ error: { code: "migrator.moved", message: error.message } }, { status: 503 }),
			}),
		);
		return { fetch: yield* Migrator.withMigrationRoute(app) };
	}),
) {}
