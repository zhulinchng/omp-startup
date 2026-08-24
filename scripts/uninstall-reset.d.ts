/** Typed surface of scripts/uninstall-reset.js (implementation is plain JS). */
export function resetOwnedQuiet(
	home: string,
):
	| "no-marker"
	| "not-owned"
	| "config-missing"
	| "write-failed"
	| "restored"
	| "preserved-true"
	| "already-default";
