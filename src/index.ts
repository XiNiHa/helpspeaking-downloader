import { Effect, pipe } from "effect";
import type { AutomationError, DownloadError, DriveError } from "./errors";
import { createDebugLogger } from "./logging";
import { runTransferWorkflow } from "./workflow";

const createErrorDetails = (error: AutomationError | DownloadError | DriveError) => {
	return {
		tag: error._tag,
		step: error.step,
		message: error.message,
		status: "status" in error ? error.status : undefined,
		screenshotUrl: "screenshotUrl" in error ? error.screenshotUrl : undefined,
	};
};

const createTransferEffect = ({
	env,
	logger,
}: {
	readonly env: Cloudflare.Env;
	readonly logger: ReturnType<typeof createDebugLogger>;
}) =>
	pipe(
		runTransferWorkflow({
			env,
			logger,
		}),
		Effect.tap((result) =>
			Effect.sync(() => {
				logger("handler.completed", "Transfer finished", result);
			}),
		),
		Effect.tapError((error) =>
			Effect.sync(() => {
				logger("handler.failed", "Transfer failed", createErrorDetails(error));
			}),
		),
	);

const createRequestLogger = (details: Record<string, unknown>) => {
	const requestId = crypto.randomUUID();
	const startedAt = new Date().toISOString();
	const logger = createDebugLogger(requestId);
	logger("handler.accepted", "Accepted transfer request", {
		...details,
		startedAt,
	});

	return {
		requestId,
		logger,
	};
};

export default {
	async fetch(_, env) {
		const { requestId, logger } = createRequestLogger({ trigger: "fetch" });

		return await Effect.runPromise(
			pipe(
				createTransferEffect({ env, logger }),
				Effect.map((result) =>
					Response.json({
						ok: true,
						requestId,
						result,
					}),
				),
				Effect.catchAll((error) =>
					Effect.succeed(
						Response.json(
							{
								ok: false,
								requestId,
								error: createErrorDetails(error),
							},
							{ status: 500 },
						),
					),
				),
			),
		);
	},
	scheduled(controller, env, context) {
		const { logger } = createRequestLogger({
			trigger: "scheduled",
			cron: controller.cron,
			scheduledTime: new Date(controller.scheduledTime).toISOString(),
		});

		const job = pipe(
			createTransferEffect({ env, logger }),
			Effect.catchAll((error) => {
				logger("handler.failed", "Transfer failed", createErrorDetails(error));
				return Effect.void;
			}),
		);
		context.waitUntil(Effect.runPromise(job));
	},
} satisfies ExportedHandler<Cloudflare.Env>;
