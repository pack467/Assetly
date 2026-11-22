import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PG_BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin';
const PG_DATA = resolve(process.cwd(), '.pgdata');
const PG_LOG = resolve(PG_DATA, 'postgres.log');
const PG_PID = resolve(PG_DATA, 'postmaster.pid');
const PG_PORT = process.env.LOCAL_PG_PORT || '5433';
const PG_DB = process.env.POSTGRES_DB || 'itam_dev';

function runPg(binName, args, stdio = 'inherit') {
	const binPath = resolve(PG_BIN, `${binName}.exe`);
	return execFileSync(binPath, args, {
		stdio,
		env: { ...process.env, PGCLIENTENCODING: 'UTF8' }
	});
}

function isReachable() {
	try {
		execFileSync(
			resolve(PG_BIN, 'psql.exe'),
			['-h', '127.0.0.1', '-p', PG_PORT, '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1;'],
			{ stdio: 'ignore' }
		);
		return true;
	} catch {
		return false;
	}
}

function initCluster() {
	if (!existsSync(resolve(PG_DATA, 'PG_VERSION'))) {
		mkdirSync(PG_DATA, { recursive: true });
		console.log(`Initializing local PostgreSQL cluster in ${PG_DATA}...`);
		runPg('initdb', ['-D', PG_DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale']);
	}
}

function startCluster() {
	initCluster();
	if (isReachable()) {
		console.log(`Local PostgreSQL cluster already reachable on port ${PG_PORT}.`);
	} else {
		if (existsSync(PG_PID)) {
			try {
				runPg('pg_ctl', ['-D', PG_DATA, 'stop', '-m', 'immediate'], 'ignore');
			} catch {
				// ignore
			}
			if (existsSync(PG_PID)) {
				rmSync(PG_PID, { force: true });
			}
		}
		console.log(`Starting local PostgreSQL cluster on port ${PG_PORT}...`);
		runPg('pg_ctl', ['-D', PG_DATA, '-l', PG_LOG, '-o', `-p ${PG_PORT}`, 'start']);
	}

	const dbCheck = execFileSync(
		resolve(PG_BIN, 'psql.exe'),
		[
			'-h',
			'127.0.0.1',
			'-p',
			PG_PORT,
			'-U',
			'postgres',
			'-d',
			'postgres',
			'-tc',
			`SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'`
		],
		{ encoding: 'utf8' }
	);

	if (!dbCheck.includes('1')) {
		runPg('psql', [
			'-h',
			'127.0.0.1',
			'-p',
			PG_PORT,
			'-U',
			'postgres',
			'-d',
			'postgres',
			'-c',
			`CREATE DATABASE "${PG_DB}";`
		]);
	}
}

function stopCluster() {
	if (!existsSync(resolve(PG_DATA, 'PG_VERSION'))) return;
	try {
		runPg('pg_ctl', ['-D', PG_DATA, 'stop', '-m', 'fast']);
	} catch {
		// already stopped
	}
}

function statusCluster() {
	if (!isReachable()) {
		console.log('Local PostgreSQL cluster is NOT running.');
		process.exit(1);
	}
	console.log(`Local PostgreSQL cluster is running on port ${PG_PORT}.`);
}

const cmd = process.argv[2] || 'status';
if (cmd === 'init') initCluster();
else if (cmd === 'start') startCluster();
else if (cmd === 'stop') stopCluster();
else statusCluster();
