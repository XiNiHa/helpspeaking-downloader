import { Effect } from "effect";
import { loadConfig } from "./config";
import { DownloadError, DriveError, isRetryableHttpStatus, toErrorMessage } from "./errors";
import { findExistingFile, requestAccessToken, uploadFileResumable } from "./google-drive";
import type { LatestLessonVideo } from "./helpspeaking";
import { fetchLatestLessonVideo } from "./helpspeaking";
import type { DebugLogger } from "./logging";

const MAX_UPLOAD_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;

interface DownloadedVideo {
	readonly body: ReadableStream<Uint8Array>;
	readonly mimeType: string;
	readonly contentLength?: number;
}

export interface TransferWorkflowResult {
	readonly status: "uploaded" | "skipped";
	readonly fileName: string;
	readonly lessonLabel: string;
	readonly driveFileId?: string;
}

const parseContentLength = (value: string | null): number | undefined => {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}

	return parsed;
};

const resolveFileExtension = (videoUrl: string): string => {
	try {
		const pathname = new URL(videoUrl).pathname;
		const extension = pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
		return extension ?? "mp4";
	} catch {
		return "mp4";
	}
};

const downloadVideo = ({
	video,
	logger,
}: {
	readonly video: LatestLessonVideo;
	readonly logger: DebugLogger;
}): Effect.Effect<DownloadedVideo, DownloadError> =>
	Effect.tryPromise({
		try: async () => {
			const headers = new Headers({
				Referer: video.referer,
			});
			if (video.cookieHeader.length > 0) {
				headers.set("Cookie", video.cookieHeader);
			}

			const response = await fetch(video.videoUrl, {
				headers,
			});

			if (!response.ok) {
				const body = await response.text();
				throw new DownloadError({
					step: "download-video",
					message: `Video request failed with status ${response.status}: ${body.slice(0, 300)}`,
					status: response.status,
					retryable: isRetryableHttpStatus(response.status),
				});
			}

			if (!response.body) {
				throw new DownloadError({
					step: "download-video",
					message: "Video response has no body stream",
				});
			}

			const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
			const contentLength = parseContentLength(response.headers.get("content-length"));
			logger("video.download", "Downloaded video source stream metadata", {
				videoUrl: video.videoUrl,
				contentLength,
				mimeType,
			});

			return {
				body: response.body,
				mimeType,
				contentLength,
			};
		},
		catch: (error) =>
			error instanceof DownloadError
				? error
				: new DownloadError({
						step: "download-video",
						message: toErrorMessage(error),
						cause: error,
					}),
	});

const uploadWithRetry = ({
	attempt,
	video,
	accessToken,
	folderId,
	fileName,
	logger,
}: {
	readonly attempt: number;
	readonly video: LatestLessonVideo;
	readonly accessToken: string;
	readonly folderId: string;
	readonly fileName: string;
	readonly logger: DebugLogger;
}): Effect.Effect<
	{
		readonly id: string;
		readonly name: string;
	},
	DownloadError | DriveError
> =>
	Effect.gen(function* () {
		logger("workflow.upload", "Starting upload attempt", {
			attempt,
			maxAttempts: MAX_UPLOAD_ATTEMPTS,
		});

		const downloadedVideo = yield* downloadVideo({
			video,
			logger,
		});
		const uploadedFile = yield* uploadFileResumable({
			accessToken,
			folderId,
			fileName,
			body: downloadedVideo.body,
			mimeType: downloadedVideo.mimeType,
			contentLength: downloadedVideo.contentLength,
			logger,
		});

		return uploadedFile;
	}).pipe(
		Effect.catchAll((error) => {
			const canRetry =
				(error instanceof DownloadError || error instanceof DriveError) &&
				error.retryable === true &&
				attempt < MAX_UPLOAD_ATTEMPTS;
			if (!canRetry) {
				return Effect.fail(error);
			}

			const waitMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
			logger("workflow.retry", "Retrying after transient failure", {
				attempt,
				waitMs,
				step: error.step,
				status: error.status,
				message: error.message,
			});
			return Effect.sleep(waitMs).pipe(
				Effect.flatMap(() =>
					uploadWithRetry({
						attempt: attempt + 1,
						video,
						accessToken,
						folderId,
						fileName,
						logger,
					}),
				),
			);
		}),
	);

export const runTransferWorkflow = ({
	env,
	logger,
}: {
	readonly env: Cloudflare.Env;
	readonly logger: DebugLogger;
}): Effect.Effect<TransferWorkflowResult, DownloadError | DriveError> =>
	Effect.gen(function* () {
		const config = yield* loadConfig(env).pipe(
			Effect.mapError(
				(error) =>
					new DriveError({
						step: "load-config",
						message: `${error.key}: ${error.message}`,
						cause: error,
					}),
			),
		);
		logger("workflow.config", "Loaded required Worker bindings");

		const latestLessonVideo = yield* fetchLatestLessonVideo({
			browserBinding: env.BROWSER,
			credentials: {
				username: config.helpspeakingUsername,
				password: config.helpspeakingPassword,
			},
			logger,
		}).pipe(
			Effect.mapError(
				(error) =>
					new DriveError({
						step: error.step,
						message: error.message,
						cause: error.cause,
					}),
			),
		);
		const fileName = latestLessonVideo.date;
		logger("workflow.video", "Fetched latest lesson video metadata", {
			lessonLabel: latestLessonVideo.lessonLabel,
			fileName,
			videoUrl: latestLessonVideo.videoUrl,
		});

		const accessToken = yield* requestAccessToken({
			credentials: {
				clientId: config.googleClientId,
				clientSecret: config.googleClientSecret,
				refreshToken: config.googleRefreshToken,
			},
			logger,
		});

		const duplicate = yield* findExistingFile({
			accessToken,
			folderId: config.googleDriveFolderId,
			fileName,
			logger,
		});
		if (duplicate) {
			logger("workflow.duplicate", "Duplicate found, skipping upload", {
				fileName,
				duplicateId: duplicate.id,
			});
			return {
				status: "skipped",
				fileName,
				lessonLabel: latestLessonVideo.lessonLabel,
				driveFileId: duplicate.id,
			} satisfies TransferWorkflowResult;
		}

		const uploadedFile = yield* uploadWithRetry({
			attempt: 1,
			video: latestLessonVideo,
			accessToken,
			folderId: config.googleDriveFolderId,
			fileName,
			logger,
		});

		return {
			status: "uploaded",
			fileName,
			lessonLabel: latestLessonVideo.lessonLabel,
			driveFileId: uploadedFile.id,
		} satisfies TransferWorkflowResult;
	});
