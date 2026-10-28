---
name: durable-object-migrator
description: Migrate Cloudflare Durable Objects off Cloudflare with no downtime, using github.com/rivet-dev/durable-object-migrator. Use when moving Durable Objects to Rivet Actors, Postgres, or another server, or when exporting Durable Object data to SQLite files.
---

# Migrate Cloudflare Durable Objects

A migration has three parts. Each Durable Object exports itself as SQL through a token-protected route. After DNS cutover, the new server moves each Durable Object the first time a request needs it (**lazy**). A background job moves the rest (**backfill**). Both call one **idempotent** `migrate` function.

The work is two copied files from the repo, not a package:

- `src/worker.ts` goes into the Cloudflare Worker.
- `src/client.ts` goes into the new server.

Read the repo's `docs/guide.md` for the cutover runbook and limits, and the example in `examples/` that matches the destination.

## Before starting

1. Map every Durable Object class. Read the Wrangler config and the Worker entry. Done when you can list, for each class: its binding, whether it is SQLite-backed (`new_sqlite_classes`) or KV-backed (`new_classes`), and how the app addresses it (`idFromName`, `getByName`, or `newUniqueId`).
2. Report what cannot move, before changing anything. KV-backed classes and virtual tables (for example FTS5) are not supported. Tell the user which classes this affects, and continue with the rest.
3. Settle the destination with the user: Rivet Actors, a Postgres-coordinated store, or local `.sqlite` files. Then read [references/destinations.md](references/destinations.md) for that destination.

## Steps

1. **Wrap the Worker.**
   - Copy `src/worker.ts` into the Worker, for example as `src/migrator.ts`, and add the `devalue` dependency.
   - For each supported class, rename it to `<Name>Impl` and export `export const <Name> = migratable(<Name>Impl);`. Keep the exported name, so the Wrangler config and its migrations stay unchanged.
   - Make background writes go through `ctx.waitUntil` or finish before the handler returns. An export waits for `ctx.waitUntil` work; a floating promise can still write after migration.
   - Make `migrationRoute(req, env, { token: env.WORKER_MIGRATOR_TOKEN })` the first thing in the default `fetch`, and return its result when it is not `null`.

   Done when every supported class exported to Wrangler is a `migratable(...)` result, and `migrationRoute` runs before any app routing. Tell the user to run `wrangler secret put WORKER_MIGRATOR_TOKEN` and deploy. Users see no change yet.

2. **Write `migrate` on the new server.**
   - Copy `src/client.ts` into the new server.
   - Create the client with a URL that still reaches Cloudflare after cutover, such as the `workers.dev` URL. The custom domain will point at the new server.
   - Write `migrate({ id })` so that a second call is a no-op and a crash leaves nothing half-written. In order: return when the object is done, clear any partial copy, apply every page from `exportObject` in order with foreign keys off, then mark it done.
   - Give each id one migration at a time: a lock, or a Rivet Actor, which runs one instance per key.
   - Treat `MigrationDirtyError` as "written to during the export": clear and run `migrate` again.

   Done when calling `migrate` twice for one id leaves exactly one copy, and a failed export leaves no copy.

3. **Add lazy migration.** Call `migrate` before serving any request that uses a Durable Object. For `idFromName` and `getByName` apps, get the id with `migrator.resolve(binding, { name })`, which does not wake the object. Done when every request path that reached a Durable Object on Cloudflare now goes through `migrate` first.

4. **Add backfill.** Run `migrator.backfill(...)` as a job that saves `startAt` through `updateStartAt` somewhere durable. It needs a Cloudflare API token with a Workers read permission. Done when a stopped job resumes from the saved position.

5. **Hand over the cutover plan.** Give the user the runbook from `docs/guide.md`: deploy the Worker change, deploy the new server, lower the DNS TTL, point DNS at the new server, run backfill a few minutes later, then run it again with `startAt: null`. Rollback is DNS back to Cloudflare plus `MIGRATOR_DISABLED=true`.

Cloudflare data stays in place for the whole migration. Leave its deletion to the user, after they confirm the new server.

## Facts users ask about

- Every finished export marks the Durable Object migrated, and it then rejects app traffic. A "download a copy" request moves the object; tell the user before running it.
- Cloudflare's list API shows new objects only after a few minutes, so backfill runs after cutover.
- Objects the migrator never saw by name come back from backfill with `name: null`. Rivet keys them `cloudflare:<id>`.
