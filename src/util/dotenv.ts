import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from '../setup/envFile.js';

/** Nearest ancestor directory that contains this package's package.json. */
export function packageRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(path.join(dir, 'package.json'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return dir;
		dir = parent;
	}
}

/**
 * Load `.env` from the working directory, falling back to the package root so
 * the bridge also finds its config when started from another directory.
 * Existing environment always wins, so the explicit service environment is
 * never clobbered by a stray repository `.env`.
 */
export function loadDotEnv(
	env: NodeJS.ProcessEnv = process.env,
	candidates: string[] = ['.env', path.join(packageRoot(), '.env')],
): void {
	const file = candidates.find((candidate) => existsSync(candidate));
	if (!file) return;
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return;
	}
	for (const [key, value] of Object.entries(parseEnvText(text))) {
		if (env[key] === undefined) env[key] = value;
	}
}
