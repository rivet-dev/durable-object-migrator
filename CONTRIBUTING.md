# Contributing

## Layout

| Path | Holds |
|---|---|
| `src/` | The files users copy. `worker.ts` and `client.ts` stay self-contained. `alchemy.ts` builds on `worker.ts`. |
| `tests/` | End-to-end tests. `tests/fixture/` is a real Worker that Wrangler's test harness runs in local workerd. `tests/alchemy-fixture/` is an Alchemy stack that `alchemy dev` runs in local workerd. |
| `tests/smoke/` | The same checks against the fixture deployed to a real Cloudflare account |
| `examples/` | Examples that must type-check |
| `docs/`, `skills/` | The guide and the agent skill |

Repository rules for humans and agents are in [CLAUDE.md](CLAUDE.md).

## Test it

```sh
pnpm install
pnpm test          # tests/ against local workerd
pnpm check-types   # src, tests, examples
pnpm lint
pnpm run ci        # everything CI runs
```

## Check it on Cloudflare

Local workerd cannot prove Cloudflare's limits, `ctx.id.name`, or the REST list API. Run the smoke check before you change the export format, the write checks, or the list logic:

```sh
CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy -c tests/fixture/wrangler.jsonc
npx wrangler secret put WORKER_MIGRATOR_TOKEN -c tests/fixture/wrangler.jsonc

SMOKE_URL=https://durable-object-migrator-smoke.<subdomain>.workers.dev \
SMOKE_TOKEN=... CF_API_TOKEN=... CF_ACCOUNT_ID=... \
node --experimental-transform-types tests/smoke/run.ts

npx wrangler delete -c tests/fixture/wrangler.jsonc
```

The list check waits up to 10 minutes for Cloudflare's list API, which shows new objects after a delay that changes from run to run.
