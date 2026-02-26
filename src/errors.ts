import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly key: string;
	readonly message: string;
}> {}

export class AutomationError extends Data.TaggedError("AutomationError")<{
	readonly step: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class DownloadError extends Data.TaggedError("DownloadError")<{
	readonly step: string;
	readonly message: string;
	readonly status?: number;
	readonly retryable?: boolean;
	readonly cause?: unknown;
}> {}

export class DriveError extends Data.TaggedError("DriveError")<{
	readonly step: string;
	readonly message: string;
	readonly status?: number;
	readonly retryable?: boolean;
	readonly cause?: unknown;
}> {}

export const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
};

export const isRetryableHttpStatus = (status: number): boolean => status === 429 || status >= 500;
