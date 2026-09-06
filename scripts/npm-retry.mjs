#!/usr/bin/env node
/**
 * Bounded, retrying wrapper around a single `npm` invocation, for CI network
 * calls that can hit a transient registry error (429/5xx/timeout) — the
 * install-smoke.yml host-range-smoke / host-latest-smoke lanes' `npm ci` and
 * `npm install` calls are all BLOCKING (or advisory-but-meant-to-succeed)
 * steps a registry hiccup must not silently kill the same way a real
 * dependency conflict does (#2613 review S3a). Same attempts/backoff shape
 * scripts/audit-prod-deps.mjs (#2579) established for the production-
 * dependency audit step; see scripts/lib/retry.mjs for the shared loop this
 * and scripts/resolve-newest-in-range-host.mjs (which needs to CAPTURE
 * `npm view`'s stdout, unlike this passthrough wrapper) both build on.
 *
 * Unlike audit-prod-deps.mjs, exhaustion here is NOT a benign pass — an
 * install that never succeeded cannot let the build continue — so this
 * still exits non-zero on exhaustion, but prints a distinct
 * `::error::infra: registry unreachable` line first so a red log is
 * immediately legible as "retried and still couldn't reach the registry"
 * rather than "a real dependency conflict on attempt 1".
 *
 * Usage: node scripts/npm-retry.mjs <npm subcommand + args...>
 * Test-only backoff override: NPM_RETRY_BACKOFF_MS="0,0,0" (comma-separated
 * ms) — see resolve-newest-in-range-host.mjs's identical override for why.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { retryWithBackoff } from "./lib/retry.mjs";

const ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [0, 5_000, 15_000];
const BACKOFF_OVERRIDE_ENV_VAR = "NPM_RETRY_BACKOFF_MS";
const ATTEMPT_TIMEOUT_MS = 120_000;

function backoffMsFrom(env) {
	const override = env?.[BACKOFF_OVERRIDE_ENV_VAR];
	if (!override) return DEFAULT_BACKOFF_MS;
	return override.split(",").map((v) => Number(v.trim()));
}

function runOnce(args) {
	return new Promise((resolvePromise) => {
		const child = spawn("npm", args, { stdio: "inherit" });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, ATTEMPT_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, timedOut });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolvePromise({ code: null, timedOut: false, error: err });
		});
	});
}

export async function main(args, env) {
	if (args.length === 0) {
		console.error("usage: npm-retry.mjs <npm subcommand + args...>");
		return 2;
	}

	let lastCode = 1;
	const result = await retryWithBackoff(
		async (attempt) => {
			const run = await runOnce(args);
			lastCode = run.code ?? 1;
			if (run.code === 0) return { ok: true, value: run };
			const reason = run.timedOut
				? `timed out after ${ATTEMPT_TIMEOUT_MS}ms`
				: run.error
					? `spawn error: ${run.error.message}`
					: `exited ${run.code}`;
			console.error(`npm-retry: attempt ${attempt + 1} ${reason}`);
			return { ok: false, reason };
		},
		{ attempts: ATTEMPTS, backoffMs: backoffMsFrom(env) },
	);

	if (result.ok) {
		if (result.attempt > 0) {
			// stderr, not stdout (#2613 review follow-through): a caller that
			// captures this script's stdout for the wrapped command's OWN
			// output (scripts/resolve-newest-in-range-host.mjs's `npm view`,
			// captured via `$(...)`) must see ONLY that output — a diagnostic
			// line on stdout would silently corrupt the captured value the
			// moment a retry ever succeeds.
			console.error(`npm-retry: succeeded on attempt ${result.attempt + 1}`);
		}
		return 0;
	}

	console.error(
		`::error::infra: registry unreachable — npm ${args.join(" ")} failed ${ATTEMPTS} times (${result.reasons.join("; ")})`,
	);
	return lastCode || 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main(process.argv.slice(2), process.env);
}
