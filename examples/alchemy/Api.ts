// The Effect Worker in front of Chat. The migrator's binding name is "Chat".
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import * as Migrator from "@rivet-dev/durable-object-migrator/alchemy";
import Chat from "./Chat.ts";

const ChatParams = Schema.Struct({ room: Schema.String });

export default class Api extends Cloudflare.Worker<Api>()(
	"Api",
	{ main: import.meta.url, compatibility: { date: "2026-07-01" } },
	Effect.gen(function* () {
		const chats = yield* Chat;

		const routes = HttpRouter.add(
			"POST",
			"/chats/:room/messages",
			Effect.gen(function* () {
				const { room } = yield* HttpRouter.schemaPathParams(ChatParams);
				const text = yield* (yield* HttpServerRequest.HttpServerRequest).text;
				yield* chats.getByName(room).addMessage(text);
				return HttpServerResponse.text("sent");
			}),
		);

		const app = (yield* HttpRouter.toHttpEffect(routes)).pipe(
			Effect.catchTags({
				SchemaError: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
				// Only reached if a request still lands on Cloudflare after the object moved.
				MigrationMovedError: () => Effect.succeed(HttpServerResponse.text("moved", { status: 503 })),
			}),
		);
		return { fetch: yield* Migrator.withMigrationRoute(app) };
	}),
) {}
