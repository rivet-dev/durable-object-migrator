// The Alchemy test stack. tests/alchemy.test.ts runs it with `alchemy dev`,
// which serves it from local workerd. It is never deployed.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import Api from "./Api.ts";

export default Alchemy.Stack(
	"DurableObjectMigratorTest",
	{ providers: Cloudflare.providers(), state: State.localState() },
	Effect.gen(function* () {
		const api = yield* Api;
		return { url: api.url.as<string>() };
	}),
);
