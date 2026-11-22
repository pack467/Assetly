import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'id.itam.app',
	appName: 'ITAM Lapangan',
	webDir: 'build-mobile',
	server: {
		androidScheme: 'https'
	}
};

export default config;
