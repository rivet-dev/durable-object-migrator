# Destinations

How `migrate` looks for each destination. Each section matches an example in the repo's `examples/` folder; start from that file.

## Rivet Actors (`examples/rivet/`)

Each Durable Object becomes an actor with the same key. The actor imports its own data, so the actor is the per-id lock.

- Import in `onMigrate`, which runs before the actor serves anything. Check for the `__do_meta` table first: it exists only after a complete import.
- Apply every page inside one `c.db.transaction(...)`, calling `tx.execute(stmt)` for each item of `page.statements`. A failed export then leaves nothing behind, and the next start retries.
- Run `PRAGMA defer_foreign_keys = ON` first inside that transaction. RivetKit enforces foreign keys, child rows can arrive before parents, and `PRAGMA foreign_keys=OFF` does nothing inside a transaction.
- RivetKit's `onMigrate` times out after 30 seconds by default. Raise it with `options: { onMigrateTimeout }` (milliseconds) on the actor for large objects. A failing import is retried on every wake, so fix persistent failures rather than letting them loop.
- Skip `isNew` as the "already imported" check. A first boot that fails mid-import is not new on retry.
- Key unnamed objects `cloudflare:<id>`, and in `onMigrate` read such a key as an id, not a name.
- Backfill wakes each actor: resolve the id to a name, then `getOrCreate([name ?? "cloudflare:" + id])` and call any action.

## Postgres coordination (`examples/postgres/`)

Postgres holds the done list, a lock per id, and the backfill position. The export is SQLite SQL, so the data goes to `.sqlite` files or another SQLite store. Translating it into Postgres tables is the user's own code.

- Take `pg_advisory_xact_lock(hashtext(id))` inside a transaction, check the done table, export, insert the done row, commit. A second caller waits on the lock and then sees the done row.
- Store `startAt` in a table keyed by binding.

## Local `.sqlite` files (`examples/export-to-sqlite/`)

- Open the file with foreign keys off: `new DatabaseSync(path, { enableForeignKeyConstraints: false })`.
- Write to `<path>.partial` and rename it when the export finishes, so a failed export never leaves a broken database.
- Retry on `MigrationDirtyError`.
