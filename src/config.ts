import { Effect } from "effect";
import { ConfigError } from "./errors";

export interface AppConfig {
	readonly helpspeakingUsername: string;
	readonly helpspeakingPassword: string;
	readonly googleClientId: string;
	readonly googleClientSecret: string;
	readonly googleRefreshToken: string;
	readonly googleDriveFolderId: string;
}

const readRequired = (
	value: string | undefined,
	key: string,
): Effect.Effect<string, ConfigError> => {
	if (typeof value !== "string" || value.trim().length === 0) {
		return Effect.fail(
			new ConfigError({
				key,
				message: `Missing required env binding: ${key}`,
			}),
		);
	}

	return Effect.succeed(value.trim());
};

export const loadConfig = (env: Cloudflare.Env): Effect.Effect<AppConfig, ConfigError> =>
	Effect.gen(function* () {
		const helpspeakingUsername = yield* readRequired(
			env.HELPSPEAKING_USERNAME,
			"HELPSPEAKING_USERNAME",
		);
		const helpspeakingPassword = yield* readRequired(
			env.HELPSPEAKING_PASSWORD,
			"HELPSPEAKING_PASSWORD",
		);
		const googleClientId = yield* readRequired(
			env.GOOGLE_OAUTH_CLIENT_ID,
			"GOOGLE_OAUTH_CLIENT_ID",
		);
		const googleClientSecret = yield* readRequired(
			env.GOOGLE_OAUTH_CLIENT_SECRET,
			"GOOGLE_OAUTH_CLIENT_SECRET",
		);
		const googleRefreshToken = yield* readRequired(
			env.GOOGLE_OAUTH_REFRESH_TOKEN,
			"GOOGLE_OAUTH_REFRESH_TOKEN",
		);
		const googleDriveFolderId = yield* readRequired(
			env.GOOGLE_DRIVE_FOLDER_ID,
			"GOOGLE_DRIVE_FOLDER_ID",
		);

		return {
			helpspeakingUsername,
			helpspeakingPassword,
			googleClientId,
			googleClientSecret,
			googleRefreshToken,
			googleDriveFolderId,
		} satisfies AppConfig;
	});
