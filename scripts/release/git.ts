// Adapted from rivet-dev/agents scripts/release/git.ts. Supports jj workspaces (including
// non-colocated ones) and plain Git checkouts.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { run } from "./exec.js";
import type { ReleaseOpts } from "./main.js";

export function usesJj(repoRoot: string): boolean {
	if (!existsSync(join(repoRoot, ".jj"))) return false;
	// If .jj exists, a failure here means a broken jj workspace. Falling back to Git could
	// release a different revision, especially in non-colocated repos.
	run("jj", ["git", "root"], { cwd: repoRoot });
	return true;
}

function gitEnv(repoRoot: string): Record<string, string | undefined> {
	if (!usesJj(repoRoot)) return {};
	return { GIT_DIR: run("jj", ["git", "root"], { cwd: repoRoot }).stdout.trim() };
}

function git(repoRoot: string, args: string[], allowFailure = false) {
	return run("git", args, { cwd: repoRoot, env: gitEnv(repoRoot), allowFailure });
}

export function getCurrentRevision(repoRoot: string): string {
	if (usesJj(repoRoot)) {
		const empty = run("jj", ["log", "-r", "@", "--no-graph", "-T", "empty"], {
			cwd: repoRoot,
		}).stdout.trim();
		const revision = empty === "true" ? "@-" : "@";
		return run("jj", ["log", "-r", revision, "--no-graph", "-T", "commit_id"], {
			cwd: repoRoot,
		}).stdout.trim();
	}
	return run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim();
}

export function getCurrentBookmark(repoRoot: string): string {
	if (usesJj(repoRoot)) {
		const { stdout } = run(
			"jj",
			[
				"log",
				"-r",
				"latest(ancestors(@) & bookmarks())",
				"--no-graph",
				"-T",
				'local_bookmarks.map(|bookmark| bookmark.name()).join("\\n") ++ "\\n"',
			],
			{ cwd: repoRoot },
		);
		const bookmarks = stdout
			.split("\n")
			.map((bookmark) => bookmark.trim())
			.filter(Boolean);
		if (bookmarks.length === 0) {
			throw new Error("The release revision is not associated with a jj bookmark");
		}
		if (bookmarks.length > 1) {
			throw new Error(
				`The release revision has multiple jj bookmarks (${bookmarks.join(", ")}); keep a single release bookmark`,
			);
		}
		return bookmarks[0];
	}
	return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }).stdout.trim();
}

export function validateClean(opts: ReleaseOpts) {
	const status = usesJj(opts.repoRoot)
		? run("jj", ["diff", "--summary", "-r", "@"], { cwd: opts.repoRoot }).stdout
		: run("git", ["status", "--porcelain"], { cwd: opts.repoRoot }).stdout;
	if (status.trim().length > 0) {
		throw new Error("There are uncommitted changes. Commit them before releasing.");
	}
}

export function commitAndPush(opts: ReleaseOpts, push: boolean) {
	const message = `chore(release): update version to ${opts.version}`;
	const cwd = opts.repoRoot;

	if (usesJj(cwd)) {
		if (!push) {
			const summary = run("jj", ["diff", "--summary", "-r", "@"], { cwd }).stdout;
			if (summary.trim()) run("jj", ["commit", "-m", message], { cwd, inherit: true });
			return;
		}
		const bookmark = getCurrentBookmark(cwd);
		const revision = getCurrentRevision(cwd);
		const remoteRef = `refs/remotes/origin/${bookmark}`;
		if (git(cwd, ["rev-parse", "-q", "--verify", remoteRef], true).exitCode === 0) {
			// jj pushes use lease semantics. Releases must also be fast-forward, even when a
			// freshly initialized workspace has not tracked origin.
			git(cwd, ["merge-base", "--is-ancestor", remoteRef, revision]);
			run("jj", ["bookmark", "track", bookmark, "--remote", "origin"], { cwd, inherit: true });
		}
		run("jj", ["bookmark", "set", bookmark, "-r", revision], { cwd, inherit: true });
		run("jj", ["git", "push", "--remote", "origin", "--bookmark", bookmark], {
			cwd,
			inherit: true,
		});
		return;
	}

	if (!push) {
		run("git", ["add", "package.json"], { cwd, inherit: true });
		const staged = run("git", ["diff", "--cached", "--name-only"], { cwd }).stdout;
		if (staged.trim()) run("git", ["commit", "-m", message], { cwd, inherit: true });
		return;
	}
	run("git", ["push", "origin", "HEAD"], { cwd, inherit: true });
}

export function createAndPushTag(opts: ReleaseOpts) {
	const tag = `v${opts.version}`;
	const cwd = opts.repoRoot;
	console.log(`Creating tag ${tag}...`);
	const existing = git(cwd, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], true);
	const target = git(cwd, ["rev-parse", `${opts.commit}^{commit}`]);
	if (existing.exitCode === 0 && existing.stdout.trim() !== target.stdout.trim()) {
		throw new Error(`${tag} already exists at a different commit`);
	}
	if (existing.exitCode !== 0) git(cwd, ["tag", tag, opts.commit]);
	run("git", ["push", "origin", `refs/tags/${tag}`], {
		cwd,
		env: gitEnv(cwd),
		inherit: true,
	});
	console.log(`✅ Tag ${tag} pushed`);
}

export function createGitHubRelease(opts: ReleaseOpts) {
	const tag = `v${opts.version}`;
	const cwd = opts.repoRoot;
	const releases: { name: string; tagName: string }[] = JSON.parse(
		run("gh", ["release", "list", "--json", "name,tagName"], { cwd }).stdout,
	);
	const existing = releases.find((release) => release.name === opts.version);
	if (existing) {
		console.log(`Updating release ${opts.version} to point to ${tag}`);
		run("gh", ["release", "edit", existing.tagName, "--tag", tag], { cwd, inherit: true });
	} else {
		console.log(`Creating release ${opts.version} for ${tag}`);
		const args = ["release", "create", tag, "--title", opts.version, "--generate-notes"];
		if (opts.version.includes("-")) args.push("--prerelease");
		if (!opts.latest) args.push("--latest=false");
		run("gh", args, { cwd, inherit: true });
	}
	console.log("✅ GitHub release created or updated");
}
