// Type declarations for resolve-newest-in-range-host.mjs (untyped .mjs
// imported from .ts tests). #2613.

export function readPeerRange(
	pkg: Record<string, unknown>,
	packageName: string,
): string;

export function pickNewestInRange(
	versions: readonly string[],
	range: string,
): string | null;
