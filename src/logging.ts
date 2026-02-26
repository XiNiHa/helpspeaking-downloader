export type DebugLogger = (step: string, message: string, details?: unknown) => void;

export const createDebugLogger = (requestId: string): DebugLogger => {
	return (step, message, details) => {
		const prefix = `[debug][${requestId}] ${step} - ${message}`;
		if (details === undefined) {
			console.debug(prefix);
			return;
		}

		console.debug(prefix, details);
	};
};
