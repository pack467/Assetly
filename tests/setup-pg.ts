import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export async function setup() {
	execFileSync('node', [resolve(process.cwd(), 'scripts/local-pg.mjs'), 'start'], {
		stdio: 'inherit'
	});
}

export async function teardown() {
	execFileSync('node', [resolve(process.cwd(), 'scripts/local-pg.mjs'), 'stop'], {
		stdio: 'inherit'
	});
}
