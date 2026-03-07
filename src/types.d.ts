namespace Cloudflare {
	interface Env {
		KV: KVNamespace;
		BROWSER: Fetcher;
		HELPSPEAKING_USERNAME: string;
		HELPSPEAKING_PASSWORD: string;
		GOOGLE_OAUTH_CLIENT_ID: string;
		GOOGLE_OAUTH_CLIENT_SECRET: string;
		GOOGLE_OAUTH_REFRESH_TOKEN: string;
		GOOGLE_DRIVE_FOLDER_ID: string;
	}
}
