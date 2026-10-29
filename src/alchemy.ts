// durable-object-migrator: Alchemy v2 adapter for Effect-native Durable Objects.
//
// Copy this file next to worker.ts. It imports "./worker", so keep that name or
// change the import. It needs `effect`, `alchemy` and `@alchemy.run/cloudflare`.
//
//   export default class Room extends Cloudflare.DurableObject<Room>()(
//     "Room",
//     Migrator.migratable(Effect.gen(function* () { ... })),
//   ) {}
//
//   // In your Worker's init:
//   return { fetch: yield* Migrator.withMigrationRoute(app) };
//
// Durable Objects written as plain classes do not need this file. Wrap them
// with `migratable` from worker.ts.

import * as Cloudflare from "@alchemy.run/cloudflare";
import type { MainRpc } from "alchemy/Platform";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MigratorState, migrationRoute, movedResponse, ROUTE_PREFIX } from "./worker";

/** The Durable Object was migrated to a new server, so it no longer serves the app. */
export class MigrationMovedError extends Schema.TaggedError<MigrationMovedError>()("MigrationMovedError", {
	message: Schema.String,
}) {}

/** What Alchemy accepts as a Durable Object: RPC members plus the optional runtime handlers. */
type Shape = MainRpc<Cloudflare.DurableObjectState> & Cloudflare.DurableObjectShape;

// Members the runtime calls. They keep their exact types.
type Handler = "fetch" | "alarm" | "webSocketMessage" | "webSocketClose" | "webSocketError";

type Guarded<M> = M extends (...args: infer P) => infer Out
	? (...args: P) => Guarded<Out>
	: M extends Effect.Effect<infer A, infer E, infer R>
		? Effect.Effect<A, E | MigrationMovedError, R>
		: M extends Stream.Stream<infer A, infer E, infer R>
			? Stream.Stream<A, E | MigrationMovedError, R>
			: M;

/** Your Durable Object's shape, where every RPC member can also fail with `MigrationMovedError`. */
export type Migratable<S> = { [K in keyof S]: K extends Handler ? S[K] : Guarded<S[K]> };

// Alchemy binds every Config read during init to the Worker, so these reach
// the Durable Object as env values with no extra setup.
const MigratorConfig = Config.all({
	token: Config.Redacted("WORKER_MIGRATOR_TOKEN"),
	disabled: Config.Boolean("MIGRATOR_DISABLED").pipe(Config.withDefault(false)),
});

const moved = () => new MigrationMovedError({ message: "this Durable Object was migrated to a new server" });

// Fails once the object moved. Otherwise counts one call as in flight.
const admit = (m: MigratorState) =>
	Effect.gen(function* () {
		if (m.isMigrated()) return yield* moved();
		m.begin();
	});

const release = (m: MigratorState) => Effect.sync(() => m.end());

// Each call stays in flight until it ends, so an export cannot finish while it
// may still write. `acquireUseRelease` releases on interrupt without closing
// the caller's Scope, which Alchemy keeps open per call.
const counted = <A, E, R>(m: MigratorState, self: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		Effect.sync(() => m.begin()),
		() => self,
		() => release(m),
	);

const guarded = <A, E, R>(m: MigratorState, self: Effect.Effect<A, E, R>) =>
	Effect.acquireUseRelease(
		admit(m),
		() => self,
		() => release(m),
	);

// `Stream.unwrap` runs `admit` on the first pull and releases when the stream
// ends, so a stream that is never consumed is never counted.
const guardedStream = <A, E, R>(m: MigratorState, self: Stream.Stream<A, E, R>) =>
	Stream.unwrap(Effect.acquireRelease(admit(m), () => release(m)).pipe(Effect.as(self)));

// The export closes every hibernated WebSocket, so an event that still
// arrives is an error, as it is for a plain class.
const guardedHandler = <E, R>(m: MigratorState, self: Effect.Effect<void, E, R>) =>
	Effect.acquireUseRelease(
		Effect.orDie(admit(m)),
		() => self,
		() => release(m),
	);

// Alchemy builds every request from a web Request, so this gives it back unchanged.
const webRequest = HttpServerRequest.HttpServerRequest.pipe(Effect.flatMap(HttpServerRequest.toWeb), Effect.orDie);

function guardMember(m: MigratorState, member: unknown): unknown {
	if (Effect.isEffect(member)) return guarded(m, member);
	if (Stream.isStream(member)) return guardedStream(m, member);
	if (typeof member !== "function") return member;
	return (...args: ReadonlyArray<unknown>) => guardMember(m, Reflect.apply(member, undefined, args));
}

function guardShape<S extends Shape>(shape: S, m: MigratorState): Migratable<S> {
	const { alarm, webSocketMessage, webSocketClose, webSocketError } = shape;
	const appFetch = shape.fetch;
	const handlers: Cloudflare.DurableObjectShape = {
		fetch: Effect.gen(function* () {
			const req = yield* webRequest;
			if (new URL(req.url).pathname.startsWith(ROUTE_PREFIX)) {
				return HttpServerResponse.fromWeb(yield* Effect.promise(() => m.handle(req)));
			}
			if (m.isMigrated()) return HttpServerResponse.fromWeb(movedResponse());
			if (appFetch === undefined) return HttpServerResponse.text("Not implemented", { status: 404 });
			return yield* counted(m, appFetch);
		}),
		// The export already saved the alarm time for the new server.
		...(alarm && {
			alarm: (info?: Cloudflare.AlarmInvocationInfo) =>
				Effect.gen(function* () {
					if (m.isMigrated()) return;
					return yield* counted(m, alarm(info));
				}),
		}),
		...(webSocketMessage && {
			webSocketMessage: (ws, message) => guardedHandler(m, webSocketMessage(ws, message)),
		}),
		...(webSocketClose && {
			webSocketClose: (ws, code, reason, wasClean) => guardedHandler(m, webSocketClose(ws, code, reason, wasClean)),
		}),
		...(webSocketError && {
			webSocketError: (ws, error) => guardedHandler(m, webSocketError(ws, error)),
		}),
	};
	const rpc = Object.fromEntries(Object.entries(shape).map(([key, member]) => [key, guardMember(m, member)]));
	// The handlers replace the guarded copies of the same keys in `rpc`.
	// Built key by key at runtime, so TypeScript cannot follow the mapped type.
	return { ...rpc, ...handlers } as Migratable<S>;
}

/**
 * Wraps an Effect-native Durable Object so it can export itself. Pass it the
 * same `Effect.gen` you pass to `Cloudflare.DurableObject`.
 *
 * Until the object is migrated it behaves the same. After that, RPC calls fail
 * with `MigrationMovedError`, fetch gets a `migrator.moved` response, and
 * alarms do not run.
 */
export const migratable = Effect.fn("Migrator.migratable")(function* <S extends Shape, R, R2>(
	impl: Effect.Effect<Effect.Effect<S, never, R>, never, R2>,
) {
	const state = yield* Cloudflare.DurableObjectState;
	// Alchemy's Durable Object init cannot fail, so a missing token stops it as a defect.
	const config = yield* MigratorConfig.pipe(Effect.orDie);
	const instance = yield* impl;
	return Effect.gen(function* () {
		const shape = yield* instance;
		const m = yield* Effect.sync(
			() => new MigratorState(state.raw, { token: Redacted.value(config.token), disabled: config.disabled }),
		);
		return guardShape(shape, m);
	});
});

/**
 * Returns your Worker's fetch with `/__migrate/*` handled first. Every other
 * request goes to `app`. Run it once in your Worker's init.
 */
export const withMigrationRoute = Effect.fn("Migrator.withMigrationRoute")(function* <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
	const token = Redacted.value((yield* MigratorConfig).token);
	return Effect.gen(function* () {
		const req = yield* webRequest;
		const handled = migrationRoute(req, yield* Cloudflare.WorkerEnvironment, { token });
		if (handled === null) return yield* app;
		return HttpServerResponse.fromWeb(yield* Effect.promise(() => handled));
	});
});
