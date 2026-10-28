# Repository Instructions

- `src/worker.ts` and `src/client.ts` are copied into user projects, not imported as a package. Keep each one self-contained: no imports between them or from other repo files. `worker.ts` may depend only on `devalue`; `client.ts` only on `fetch`.
- The two files share only the HTTP contract: `/__migrate/:binding/{export,resolve}`, the `x-migrator` response header, and `migrator.*` error codes. Change both sides together.
- Never add a code path that deletes or rewrites user data on Cloudflare. The only allowed writes are the `__migrator` state table and removing a migrated object's alarm, which is saved there so rollback can restore it.
- An export may mark a Durable Object migrated only inside the same `transactionSync` as the dirty check.
- Tests run the real fixture Worker (`tests/fixture/wrangler.jsonc`) through Wrangler's `createTestHarness` and talk to it over HTTP. Do not use Miniflare directly, mocks, or direct calls into `src/worker.ts`.
- Test outcomes a caller can observe. Never paper over a flake with retries or longer waits; find the race.
- `tests/smoke/run.ts` checks what local workerd cannot: Cloudflare limits, `ctx.id.name`, the REST list API. Run it before changing the export format or the list logic. Keep account ids and URLs out of the repo.
- Examples in `examples/` must type-check (`pnpm check-types`). Update `docs/guide.md` and the README API table when the API changes.
- Write docs and comments in plain, complete sentences. Lead with what the user does or gets.
