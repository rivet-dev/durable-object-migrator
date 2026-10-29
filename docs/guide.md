# Guide

How a migration works, from wrapping the Worker to turning Cloudflare off. For the API, see the [README](../README.md).

## Cutover runbook

1. Wrap your Durable Object classes and add `migrationRoute` ([README](../README.md#worker)). Set `WORKER_MIGRATOR_TOKEN` and deploy. Nothing changes for users.
2. Deploy the new server with `migrate` called before each request (part 1 below).
3. A day ahead, lower your DNS TTL (for example to 60 seconds) so caches expire fast.
4. Point your domain at the new server. From now on, Durable Objects move on first use.
5. Wait a few minutes, then run backfill (part 2 below). Cloudflare's list API shows new Durable Objects only after a delay.
6. Run backfill again with `startAt: null`. It catches Durable Objects that clients with stale DNS created on Cloudflare after the first run.
7. Once you trust the new server, delete the Worker and its data yourself. The migrator never deletes anything.

## Part 0: the migrate function

```ts
// user writes this
async function migrate({ id }) {
  if (await isDone(id)) return;           // already moved
  await clearDestination(id);             // drop a half-finished attempt
  for await (const page of migrator.exportObject({ binding: "ROOMS", id })) {
    await destination(id).exec(page.sql); // page = SQL statements
  }
  await markDone(id);
}
```

It must be safe to call many times. Lazy migration and backfill both call it, and a crash or a dirty export means it runs again.

Run it on an empty database with foreign keys off. Child rows can arrive before parent rows. Inside a transaction, `PRAGMA foreign_keys=OFF` does nothing, so run `PRAGMA defer_foreign_keys = ON` first instead: the checks then run at commit.

## Part 1: lazy migration

Point DNS at your new server. Each request moves its Durable Object first:

```ts
app.use("/rooms/:name/*", async (c, next) => {
  const { id } = await migrator.resolve("ROOMS", { name: c.req.param("name") });
  await migrate({ id });                  // no-op once done
  return next();
});
```

A user only waits for their own Durable Object, and only once.

## Part 2: backfill

Moves every Durable Object nobody touched:

```ts
await migrator.backfill({
  cloudflare: { apiToken, accountId, scriptName: "my-app", className: "Room" }, // lists the Durable Objects
  startAt: await loadPosition(),          // resume point
  updateStartAt: savePosition,
  migrate,                                // same function as lazy
});
```

- Run it a few minutes after the DNS cutover. Cloudflare's list API shows new Durable Objects only after a delay.
- Run it again with `startAt: null` to catch objects that clients with stale DNS created later. Your `migrate` skips finished Durable Objects without waking them.
- The API token needs a Workers read permission.
- A Durable Object that keeps failing is reported in `failed`. The rest still move.

## What an export contains

Plain SQL. Pipe it into `sqlite3` and you get a real `.sqlite` file.

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE "__do_kv"(key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- KV data, devalue-encoded
CREATE TABLE "__do_meta"(key TEXT PRIMARY KEY, value);              -- id, name, alarm
CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO "messages"("id", "body") VALUES (1, 'hello');
INSERT INTO "__do_kv"(key, value) VALUES ('config', '[{"theme":1},"dark"]');
INSERT INTO "__do_meta"(key, value) VALUES ('id', '…'), ('name', 'lobby'), ('alarm', 1761700000000);
CREATE INDEX messages_body ON messages(body);                       -- indexes, triggers, views last
```

- Integers and reals go through `quote()`, so big integers and `5.0` stay exact. Text and blobs are encoded in JS.
- Rowids are kept, even for tables without an `INTEGER PRIMARY KEY`.
- The export does not freeze the Durable Object. The last page checks whether anything was written during the export. If nothing was, the Durable Object is marked migrated in the same transaction and starts rejecting app traffic. If something was, the export throws `MigrationDirtyError` and `migrate` runs again.

## Why not stop-the-world migrations

Stop-the-world means putting the whole app in maintenance mode, copying all the data, then switching over.

- Everyone is down for the whole copy, and that time grows with your total data.
- With lazy migration, a user only waits for their own Durable Object.
- Even Cloudflare's own D1 export blocks the database while it runs.

## Rollback

Rolling back is serving your Durable Object code through Workers again. Point DNS back at Cloudflare and set `MIGRATOR_DISABLED=true` so every Durable Object serves normally again. Anything written on the new server after cutover stays there. It does not sync back to Cloudflare.

A Durable Object that stays busy can keep running with the old Worker settings for up to 5 minutes after you deploy, so it can keep refusing requests for that long. This is a [known Cloudflare issue](https://github.com/cloudflare/workers-sdk/issues/16235).

The migrator never deletes data on Cloudflare. Its writes are its own `__migrator` table and the alarm:

- When a Durable Object is copied, its pending alarm is removed, so scheduled work cannot run on the old copy. The new server gets the alarm time in `__do_meta`.
- With `MIGRATOR_DISABLED=true`, the alarm is set again the next time the object starts. If its time has passed, it runs right away. An object that gets no request after rollback keeps its alarm off until it does.

## Alchemy

[Alchemy v2](https://alchemy.run) has two ways to write a Durable Object. Both can be migrated. See [`examples/alchemy/`](../examples/alchemy/).

**Plain class.** Wrap it with `migratable` and add `migrationRoute`, as in the [README](../README.md#getting-started). Put the token and the rollback flag in the Worker's env:

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

**Effect-native.** Alchemy writes the class for you, so there is no class to wrap. Copy [`src/alchemy.ts`](../src/alchemy.ts) next to `src/worker.ts` and wrap the Effect instead:

```ts
import * as Migrator from "./alchemy"; // src/alchemy.ts

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

For both kinds:

- Backfill needs the Worker's script name. Use the `workerName` output of your stack, not the stack name.
- If you read env directly in an Effect Worker (for example through `Cloudflare.WorkerEnvironment`), values that Alchemy bound from `Config` arrive wrapped, as `{"_tag":"Redacted","value":"..."}`. Read them with `Config` instead.

## Limits

| Limit | What it means |
|---|---|
| A row is at most 2 MB on Cloudflare | One row always fits in a page. A 2 MB blob becomes a ~4 MB `INSERT`. |
| Pages are about 4 MB | Tested in production with 1.5 MB rows |
| The Cloudflare list API shows a new Durable Object only after a delay | Usually a few minutes. We measured up to 8, but Cloudflare does not document the delay and it changes from run to run. Run backfill a few minutes after cutover, and again with `startAt: null` to catch late objects. |
| The Cloudflare list API returns ids, not names | The migrator saves each Durable Object's name when it sees one. Objects it never saw by name have no name. |
| KV values are JS values (`Date`, `Map`, …) | Stored as [devalue](https://github.com/sveltejs/devalue) strings in `__do_kv`. Values devalue cannot encode fail the export with a clear error. |
| A Durable Object that keeps getting writes | Its export keeps retrying |
| Virtual tables (FTS5) | Not supported. The export fails with a clear error. |
| Writes from background work after its request returns | Covered when the work goes through `ctx.waitUntil`: an export cannot finish while it is pending. Work that is neither awaited nor passed to `ctx.waitUntil` (a floating promise, a detached Effect fiber) can still write after migration and be lost. |
| Sockets accepted with `ws.accept()` instead of hibernation | Not closed after migration |
| Alchemy alarm callbacks (`Alchemy.makeCallback`) | A callback that is still running when an export finishes is not counted as in flight, so a write it makes after that point stays on the old copy. The export removes the pending alarm, so no new callback starts after migration. |
| KV-backed (non-SQLite) Durable Objects | Not supported |
| Every finished export marks the Durable Object migrated | There is no backup-only export yet. Exporting a Durable Object moves it. |
