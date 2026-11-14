import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, run } from "./exec.js";
import type { ReleaseOpts } from "./main.js";

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

export function readManifest(repoRoot: string): PackageManifest {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

/** Same dist-tag rules as rivet-dev/agents: `rc`, then `latest`, then the minor channel. */
export function distTag(opts: ReleaseOpts): string {
	if (opts.version.includes("-rc.")) return "rc";
	if (opts.version.includes("-")) return "next";
	return opts.latest ? "latest" : opts.minorVersionChannel;
}

function npmVersionExists(repoRoot: string, name: string, version: string): boolean {
	const result = run("npm", ["view", `${name}@${version}`, "version"], {
		cwd: repoRoot,
		allowFailure: true,
	});
	return result.exitCode === 0 && result.stdout.trim() === version;
}

export function publishNpm(opts: ReleaseOpts) {
	const manifest = readManifest(opts.repoRoot);
	if (manifest.version !== opts.version) {
		throw new Error(`package.json is at ${manifest.version}, not ${opts.version}. Run the setup-local phase first.`);
	}

	for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
		if (/^0\.0\.0-/.test(range)) {
			console.warn(`⚠️ Publishing with preview dependency ${name}@${range}`);
		}
	}

	if (npmVersionExists(opts.repoRoot, manifest.name, opts.version)) {
		console.log(`${manifest.name}@${opts.version} already exists on npm. Skipping.`);
		return;
	}

	const tag = distTag(opts);
	console.log(`==> Publishing ${manifest.name}@${opts.version} with dist-tag ${tag}`);
	// In the repo, the exports point at src/. `pnpm pack` applies `publishConfig.exports` (dist/)
	// and runs `prepack`, which builds dist/. npm ignores `publishConfig.exports`, so npm publishes
	// that tarball as is. npm, not pnpm, publishes: npm 11.5.1+ authenticates with GitHub's OIDC
	// token (npm trusted publishing).
	const directory = mkdtempSync(join(tmpdir(), "durable-object-migrator-pack-"));
	try {
		run("pnpm", ["pack", "--pack-destination", directory], { cwd: opts.repoRoot, inherit: true });
		const tarball = join(directory, readdirSync(directory).find((name) => name.endsWith(".tgz")) ?? "");
		const packed = run("tar", ["-xOzf", tarball, "package/package.json"], { cwd: opts.repoRoot }).stdout;
		assert(
			!JSON.stringify(JSON.parse(packed).exports).includes("./src/"),
			"The packed exports point at src/, not dist/",
		);
		run("npm", ["publish", tarball, "--access", "public", "--tag", tag], { cwd: opts.repoRoot, inherit: true });
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
	console.log(`✅ Published ${manifest.name}@${opts.version}`);
}
