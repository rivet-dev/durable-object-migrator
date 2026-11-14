#!/usr/bin/env tsx
// Release script, the same as rivet-dev/open-orange scripts/release. A release runs in two phases:
//
// - `setup-local` (default, on your machine): bump package.json, run checks, commit and push the
//   version bump on the current bookmark, then trigger the release workflow on that bookmark.
// - `complete-ci` (in .github/workflows/release.yaml): run checks again, publish to npm, push the
//   `v<version>` tag, and create the GitHub release.
//
// Usage: pnpm release --version 0.1.0 | --patch | --minor | --major [--no-latest]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { assert, run } from "./exec.js";
import {
	commitAndPush,
	createAndPushTag,
	createGitHubRelease,
	getCurrentBookmark,
	getCurrentRevision,
	usesJj,
	validateClean,
} from "./git.js";
import { distTag, publishNpm, readManifest } from "./npm.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ReleaseOpts {
	repoRoot: string;
	version: string;
	latest: boolean;
	minorVersionChannel: string;
	/** Commit the release is tagged at. */
	commit: string;
}

const STEPS = [
	"confirm-release",
	"update-version",
	"run-checks",
	"git-commit",
	"git-push",
	"trigger-workflow",
	"publish-npm",
	"push-tag",
	"create-github-release",
] as const;
type Step = (typeof STEPS)[number];

const PHASES = {
	// These steps change the source, so they run and commit locally. CI cannot push commits.
	"setup-local": ["confirm-release", "update-version", "run-checks", "git-commit", "git-push", "trigger-workflow"],
	"complete-ci": [
		"run-checks",
		"publish-npm",
		"push-tag",
		// Fires the repository's release webhooks. It can also run alone with
		// `--only-steps create-github-release`.
		"create-github-release",
	],
} satisfies Record<string, Step[]>;
type Phase = keyof typeof PHASES;

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseStable(version: string): [number, number, number] | null {
	const match = SEMVER.exec(version);
	if (!match || match[4]) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareStable(a: [number, number, number], b: [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function gitVersions(): string[] {
	const env = usesJj(REPO_ROOT) ? { GIT_DIR: run("jj", ["git", "root"], { cwd: REPO_ROOT }).stdout.trim() } : {};
	run("git", ["fetch", "--tags", "--force", "--quiet"], {
		cwd: REPO_ROOT,
		env,
		allowFailure: true,
	});
	return run("git", ["tag", "-l", "v*"], { cwd: REPO_ROOT, env })
		.stdout.split("\n")
		.map((tag) => tag.trim().replace(/^v/, ""))
		.filter((version) => SEMVER.test(version));
}

function resolveVersion(values: { version?: string; major?: boolean; minor?: boolean; patch?: boolean }): string {
	if (values.version) return values.version;
	if (!values.major && !values.minor && !values.patch) {
		throw new Error("Pass --version, --major, --minor, or --patch");
	}
	// Bump from the newest stable tag, or package.json before the first tag exists.
	const candidates = [...gitVersions(), readManifest(REPO_ROOT).version]
		.map(parseStable)
		.filter((version) => version !== null);
	assert(candidates.length > 0, "No stable version to bump from; pass --version");
	const [major, minor, patch] = candidates.sort(compareStable).at(-1)!;
	if (values.major) return `${major + 1}.0.0`;
	if (values.minor) return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function updateVersion(opts: ReleaseOpts) {
	// Replace only the version field so package.json formatting is untouched.
	const path = join(opts.repoRoot, "package.json");
	const source = readFileSync(path, "utf8");
	const updated = source.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${opts.version}"`);
	writeFileSync(path, updated);
	assert(readManifest(opts.repoRoot).version === opts.version, "Could not update the package.json version");
	console.log(`✅ package.json is at ${opts.version}`);
}

function runChecks(opts: ReleaseOpts) {
	// Lint, format, types, and the tests against local workerd.
	console.log("==> pnpm run ci");
	run("pnpm", ["run", "ci"], { cwd: opts.repoRoot, inherit: true });
	console.log("✅ Checks passed");
}

async function confirmRelease(opts: ReleaseOpts) {
	console.log("\nRelease details:");
	console.log(`  Version: ${opts.version}`);
	console.log(`  npm dist-tag: ${distTag(opts)}`);
	console.log(`  Commit: ${opts.commit}`);
	console.log(`  Branch: ${getCurrentBookmark(opts.repoRoot)}`);
	const recent = gitVersions().sort().reverse().slice(0, 10);
	if (recent.length > 0) console.log(`  Recent tags: ${recent.join(", ")}`);
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await prompt.question("\nProceed with release? (yes/no): ")).toLowerCase();
	prompt.close();
	if (answer !== "yes" && answer !== "y") {
		console.log("Release cancelled");
		process.exit(0);
	}
}

function triggerWorkflow(opts: ReleaseOpts) {
	const branch = getCurrentBookmark(opts.repoRoot);
	run(
		"gh",
		[
			"workflow",
			"run",
			"release.yaml",
			"--ref",
			branch,
			"-f",
			`version=${opts.version}`,
			"-f",
			`latest=${opts.latest}`,
		],
		{ cwd: opts.repoRoot, inherit: true },
	);
	const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
		cwd: opts.repoRoot,
	}).stdout.trim();
	console.log(`\nWorkflow triggered: https://github.com/${repo}/actions/workflows/release.yaml`);
}

async function main() {
	const { values } = parseArgs({
		options: {
			version: { type: "string" },
			major: { type: "boolean" },
			minor: { type: "boolean" },
			patch: { type: "boolean" },
			"no-latest": { type: "boolean" },
			"no-validate-git": { type: "boolean" },
			"override-commit": { type: "string" },
			phase: { type: "string" },
			"only-steps": { type: "string" },
		},
	});

	if (values.phase && values["only-steps"]) {
		throw new Error("Cannot use both --phase and --only-steps");
	}
	const requested = new Set<Step>();
	if (values["only-steps"]) {
		for (const step of values["only-steps"].split(",").map((s) => s.trim())) {
			assert(STEPS.includes(step as Step), `Invalid step ${step}. Available: ${STEPS.join(", ")}`);
			requested.add(step as Step);
		}
	} else {
		for (const phase of (values.phase ?? "setup-local").split(",").map((s) => s.trim())) {
			assert(phase in PHASES, `Invalid phase ${phase}. Available: ${Object.keys(PHASES).join(", ")}`);
			for (const step of PHASES[phase as Phase]) requested.add(step);
		}
	}
	const shouldRun = (step: Step) => requested.has(step);

	const version = resolveVersion(values);
	assert(SEMVER.test(version), `${version} is not a valid semantic version`);
	const [major, minor] = version.split(".");
	const validateGit = !values["no-validate-git"];

	const opts: ReleaseOpts = {
		repoRoot: REPO_ROOT,
		version,
		latest: !values["no-latest"],
		minorVersionChannel: `${major}.${minor}.x`,
		commit: values["override-commit"] ?? getCurrentRevision(REPO_ROOT),
	};

	if (validateGit && shouldRun("git-commit")) validateClean(opts);

	if (shouldRun("confirm-release")) await confirmRelease(opts);
	if (shouldRun("update-version")) updateVersion(opts);
	if (shouldRun("run-checks")) runChecks(opts);
	if (shouldRun("git-commit")) {
		assert(validateGit, "Cannot commit without git validation");
		commitAndPush(opts, false);
	}
	if (shouldRun("git-push")) {
		assert(validateGit, "Cannot push without git validation");
		commitAndPush(opts, true);
	}
	if (shouldRun("trigger-workflow")) triggerWorkflow(opts);
	if (shouldRun("publish-npm")) publishNpm(opts);
	if (shouldRun("push-tag")) createAndPushTag(opts);
	if (shouldRun("create-github-release")) createGitHubRelease(opts);

	console.log("==> Complete");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
