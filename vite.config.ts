import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	for (const [key, value] of Object.entries(env)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}

	return {
		plugins: [tailwindcss(), sveltekit()],
		test: {
			include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
			globalSetup: ['./tests/setup-pg.ts'],
			environment: 'node',
			fileParallelism: false,
			testTimeout: 25000,
			env
		}
	};
});
