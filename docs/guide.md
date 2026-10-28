# Guide

How a migration works, from wrapping the Worker to turning Cloudflare off. For the API, see the [README](../README.md).

## Cutover runbook

1. Wrap your Durable Object classes and add `migrationRoute` ([README](../README.md#worker)). Set `WORKER_MIGRATOR_TOKEN` and deploy. Nothing changes for users.
2. Deploy the new server with `migrate` called before each request (part 1 below).
3. A day ahead, lower your DNS TTL (for example to 60 seconds) so caches expire fast.
4. Point your domain at the new server. From now on, Durable Objects move on first use.
5. Wait a few minutes, then run backfill (part 2 below).
6. Run backfill again with `startAt: null` to confirm nothing was missed.
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

- Run it after the DNS cutover. Cloudflare's list API shows new objects only after a few minutes.
- Run it again with `startAt: null` to confirm nothing was missed. Your `migrate` skips finished Durable Objects without waking them.
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

Inside the Durable Object, the export runs plain SQL:

```ts
sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'table'`)              // CREATE TABLE …
sql.exec(`SELECT quote(rowid), … FROM "messages" WHERE (rowid) > (?) …`)    // INSERT …, keyset pages
await ctx.storage.list({ startAfter, limit: 128 })                          // KV → __do_kv
await ctx.storage.getAlarm()                                                // alarm → __do_meta
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

The migrator never deletes data on Cloudflare. Its only write is its own `__migrator` table.

## Limits

| Limit | What it means |
|---|---|
| A row is at most 2 MB on Cloudflare | One row always fits in a page. A 2 MB blob becomes a ~4 MB `INSERT`. |
| Pages are about 4 MB | Tested in production with 1.5 MB rows |
| The Cloudflare list API lags behind new objects by about 5 minutes (measured) | Run backfill a while after cutover, and run it again with `startAt: null` to catch late objects |
| The Cloudflare list API returns ids, not names | The migrator saves each Durable Object's name when it sees one. Objects it never saw by name have no name. |
| KV values are JS values (`Date`, `Map`, …) | Stored as [devalue](https://github.com/sveltejs/devalue) strings in `__do_kv`. Values devalue cannot encode fail the export with a clear error. |
| A Durable Object that keeps getting writes | Its export keeps retrying |
| Virtual tables (FTS5) | Not supported. The export fails with a clear error. |
| Writes from background work after its request returns | Covered when the work goes through `ctx.waitUntil`: an export cannot finish while it is pending. Work that is neither awaited nor passed to `ctx.waitUntil` (a floating promise, a detached Effect fiber) can still write after migration and be lost. |
| Sockets accepted with `ws.accept()` instead of hibernation | Not closed after migration |
| KV-backed (non-SQLite) Durable Objects | Not supported |
| Every finished export marks the Durable Object migrated | There is no backup-only export yet. Exporting a Durable Object moves it. |
