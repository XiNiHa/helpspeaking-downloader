import { env } from "cloudflare:workers";
import { Effect } from "effect";

export interface Alert {
	readonly subject: string;
	readonly lines: ReadonlyArray<string>;
	readonly screenshot?: string | null | undefined;
}

const SCREENSHOT_PREFIX = "data:image/png;base64,";

export const sendAlert = ({ subject, lines, screenshot }: Alert) =>
	Effect.tryPromise(() =>
		env.EMAIL.send({
			from: { name: "Helpspeaking", email: env.EMAIL_FROM },
			to: env.EMAIL_TO,
			subject: `[Helpspeaking] ${subject}`,
			text: [...lines, "", env.APP_URL].join("\n"),
			attachments: screenshot?.startsWith(SCREENSHOT_PREFIX)
				? [
						{
							disposition: "attachment",
							filename: "screenshot.png",
							type: "image/png",
							content: Uint8Array.from(atob(screenshot.slice(SCREENSHOT_PREFIX.length)), (char) =>
								char.charCodeAt(0),
							),
						},
					]
				: undefined,
		}),
	).pipe(
		Effect.asVoid,
		Effect.catch((error) => Effect.logError("Failed to send alert email", error)),
	);
