import { spawnSync } from "node:child_process";

export interface RunOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Stream output to the terminal instead of capturing it. */
	inherit?: boolean;
	/** Return a non-zero exit code instead of throwing. */
	allowFailure?: boolean;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs a command without a shell, so arguments never need quoting. */
export function run(command: string, args: string[], opts: RunOptions): RunResult {
	const result = spawnSync(command, args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		encoding: "utf8",
		stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	const exitCode = result.status ?? 1;
	const output = {
		exitCode,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
	if (exitCode !== 0 && !opts.allowFailure) {
		const detail = opts.inherit ? "" : `\n${output.stderr || output.stdout}`;
		throw new Error(`${command} ${args.join(" ")} exited with ${exitCode}${detail}`);
	}
	return output;
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
