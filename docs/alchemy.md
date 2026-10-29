# Alchemy

How to migrate Durable Objects defined with Alchemy. For the full switch-over, see the [guide](guide.md).

[Alchemy v2](https://alchemy.run) has two ways to write a Durable Object. Both can be migrated. See [`examples/alchemy/`](../examples/alchemy/).

## Plain class

Wrap it with `migratable` and add `migrationRoute`, as in [step 1 of the README](../README.md#step-1-add-the-migrator-to-your-durable-object). Put the token and the rollback flag in the Worker's env:

```ts
export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: {
    ROOMS: Rooms,
    WORKER_MIGRATOR_TOKEN: Config.Redacted("WORKER_MIGRATOR_TOKEN"),
    MIGRATOR_DISABLED: Config.String("MIGRATOR_DISABLED").pipe(Config.withDefault("false")),
  },
});
```

## Effect-native

Alchemy writes the class for you, so there is no class to wrap. Wrap the Effect with the Alchemy adapter instead. It needs `effect`, `alchemy` and `@alchemy.run/cloudflare`, which your Alchemy project already has:

```ts
import * as Migrator from "@rivet-dev/durable-object-migrator/alchemy";

export default class Room extends Cloudflare.DurableObject<Room>()(
  "Room",
  Migrator.migratable(Effect.gen(function* () { /* your Durable Object */ })),
) {}

// In your Worker's init:
return { fetch: yield* Migrator.withMigrationRoute(app) };
```

- The adapter reads `WORKER_MIGRATOR_TOKEN` and `MIGRATOR_DISABLED` with `Config`, so Alchemy adds them to the Worker. Set them in `.env` before you deploy.
- After migration, every RPC method fails with `MigrationMovedError`. It is part of each method's error type, so you can handle it with `Effect.catchTag("MigrationMovedError", ...)`. Your methods keep their own argument and return types.
- The binding name is the Durable Object's name: `exportObject({ binding: "Room", id })`.

## Both kinds

- Backfill needs the Worker's script name. Use the `workerName` output of your stack, not the stack name.
- If you read env directly in an Effect Worker (for example through `Cloudflare.WorkerEnvironment`), values that Alchemy bound from `Config` arrive wrapped, as `{"_tag":"Redacted","value":"..."}`. Read them with `Config` instead.

## API

| API | Does |
|---|---|
| `Migrator.migratable(effect)` | Wraps an Effect-native Durable Object. After migration its RPC methods fail with `MigrationMovedError`. |
| `yield* Migrator.withMigrationRoute(app)` | Gives back your Worker's fetch with `/__migrate/*` handled first. |

## Limits

The [general limits](guide.md#limits) apply, plus:

| Limit | What it means |
|---|---|
| Alchemy alarm callbacks (`Alchemy.makeCallback`) | A callback that is still running when an export finishes is not counted as in flight, so a write it makes after that point stays on the old copy. The export removes the pending alarm, so no new callback starts after migration. |
