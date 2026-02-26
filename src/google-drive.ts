import { Effect } from "effect";
import { DriveError, isRetryableHttpStatus, toErrorMessage } from "./errors";
import type { DebugLogger } from "./logging";

interface GoogleTokenResponse {
	readonly access_token?: string;
	readonly expires_in?: number;
}

interface GoogleDriveListResponse {
	readonly files?: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
	}>;
}

interface GoogleDriveUploadResponse {
	readonly id?: string;
	readonly name?: string;
}

export interface DriveFileSummary {
	readonly id: string;
	readonly name: string;
}

export interface DriveOAuthCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
}

export interface DriveUploadInput {
	readonly accessToken: string;
	readonly folderId: string;
	readonly fileName: string;
	readonly body: ReadableStream<Uint8Array>;
	readonly mimeType: string;
	readonly contentLength?: number;
}

const escapeQueryValue = (value: string): string =>
	value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

const formatHttpFailureMessage = async (response: Response): Promise<string> => {
	const body = await response.text();
	if (body.length === 0) {
		return `${response.status} ${response.statusText}`;
	}

	return `${response.status} ${response.statusText} - ${body.slice(0, 300)}`;
};

export const requestAccessToken = ({
	credentials,
	logger,
}: {
	readonly credentials: DriveOAuthCredentials;
	readonly logger: DebugLogger;
}): Effect.Effect<string, DriveError> =>
	Effect.tryPromise({
		try: async () => {
			const tokenBody = new URLSearchParams({
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				refresh_token: credentials.refreshToken,
				grant_type: "refresh_token",
			});

			const response = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: tokenBody,
			});

			if (!response.ok) {
				const message = await formatHttpFailureMessage(response);
				throw new DriveError({
					step: "request-access-token",
					message: `Failed to exchange refresh token: ${message}`,
					status: response.status,
					retryable: isRetryableHttpStatus(response.status),
				});
			}

			const payload = (await response.json()) as GoogleTokenResponse;
			if (!payload.access_token) {
				throw new DriveError({
					step: "request-access-token",
					message: "Google token response does not include access_token",
				});
			}

			logger("drive.auth", "Obtained OAuth access token", {
				expiresIn: payload.expires_in,
			});
			return payload.access_token;
		},
		catch: (error) =>
			error instanceof DriveError
				? error
				: new DriveError({
						step: "request-access-token",
						message: toErrorMessage(error),
						cause: error,
					}),
	});

export const findExistingFile = ({
	accessToken,
	folderId,
	fileName,
	logger,
}: {
	readonly accessToken: string;
	readonly folderId: string;
	readonly fileName: string;
	readonly logger: DebugLogger;
}): Effect.Effect<DriveFileSummary | null, DriveError> =>
	Effect.tryPromise({
		try: async () => {
			const query = `name = '${escapeQueryValue(fileName)}' and '${escapeQueryValue(folderId)}' in parents and trashed = false`;
			const url = new URL("https://www.googleapis.com/drive/v3/files");
			url.searchParams.set("q", query);
			url.searchParams.set("fields", "files(id,name)");
			url.searchParams.set("pageSize", "1");
			url.searchParams.set("supportsAllDrives", "true");
			url.searchParams.set("includeItemsFromAllDrives", "true");

			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			});

			if (!response.ok) {
				const message = await formatHttpFailureMessage(response);
				throw new DriveError({
					step: "find-existing-file",
					message: `Failed listing Drive files: ${message}`,
					status: response.status,
					retryable: isRetryableHttpStatus(response.status),
				});
			}

			const payload = (await response.json()) as GoogleDriveListResponse;
			const existingFile = payload.files?.[0] ?? null;
			logger("drive.lookup", "Finished duplicate lookup", {
				fileName,
				duplicateFound: existingFile !== null,
			});

			return existingFile;
		},
		catch: (error) =>
			error instanceof DriveError
				? error
				: new DriveError({
						step: "find-existing-file",
						message: toErrorMessage(error),
						cause: error,
					}),
	});

export const uploadFileResumable = ({
	accessToken,
	folderId,
	fileName,
	body,
	mimeType,
	contentLength,
	logger,
}: DriveUploadInput & { readonly logger: DebugLogger }): Effect.Effect<
	DriveFileSummary,
	DriveError
> =>
	Effect.tryPromise({
		try: async () => {
			const initUrl = new URL("https://www.googleapis.com/upload/drive/v3/files");
			initUrl.searchParams.set("uploadType", "resumable");
			initUrl.searchParams.set("supportsAllDrives", "true");

			const initHeaders = new Headers({
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Type": mimeType,
			});
			if (contentLength !== undefined) {
				initHeaders.set("X-Upload-Content-Length", String(contentLength));
			}

			const initResponse = await fetch(initUrl, {
				method: "POST",
				headers: initHeaders,
				body: JSON.stringify({
					name: fileName,
					parents: [folderId],
				}),
			});

			if (!initResponse.ok) {
				const message = await formatHttpFailureMessage(initResponse);
				throw new DriveError({
					step: "init-resumable-upload",
					message: `Failed to start resumable upload: ${message}`,
					status: initResponse.status,
					retryable: isRetryableHttpStatus(initResponse.status),
				});
			}

			const uploadUrl = initResponse.headers.get("location");
			if (!uploadUrl) {
				throw new DriveError({
					step: "init-resumable-upload",
					message: "Google Drive resumable upload response does not include location header",
				});
			}

			const uploadHeaders = new Headers({
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": mimeType,
			});
			if (contentLength !== undefined) {
				uploadHeaders.set("Content-Length", String(contentLength));
			}

			const uploadResponse = await fetch(uploadUrl, {
				method: "PUT",
				headers: uploadHeaders,
				body,
			});

			if (!uploadResponse.ok) {
				const message = await formatHttpFailureMessage(uploadResponse);
				throw new DriveError({
					step: "put-resumable-upload",
					message: `Failed uploading media bytes: ${message}`,
					status: uploadResponse.status,
					retryable: isRetryableHttpStatus(uploadResponse.status),
				});
			}

			const payload = (await uploadResponse.json()) as GoogleDriveUploadResponse;
			if (!payload.id) {
				throw new DriveError({
					step: "put-resumable-upload",
					message: "Google Drive upload response does not include file id",
				});
			}

			logger("drive.upload", "Upload completed", {
				fileId: payload.id,
				fileName: payload.name ?? fileName,
			});
			return {
				id: payload.id,
				name: payload.name ?? fileName,
			};
		},
		catch: (error) =>
			error instanceof DriveError
				? error
				: new DriveError({
						step: "upload-file-resumable",
						message: toErrorMessage(error),
						cause: error,
					}),
	});
