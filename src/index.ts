import { Effect, pipe } from "effect";
import { createDebugLogger } from "./logging";
import { runTransferWorkflow } from "./workflow";

const createErrorDetails = (error: unknown) => {
	if (typeof error === "object" && error !== null) {
		const details = error as {
			readonly _tag?: unknown;
			readonly step?: unknown;
			readonly message?: unknown;
			readonly status?: unknown;
		};

		return {
			tag: typeof details._tag === "string" ? details._tag : "UnknownError",
			step: typeof details.step === "string" ? details.step : "unknown",
			message: typeof details.message === "string" ? details.message : String(error),
			status: typeof details.status === "number" ? details.status : undefined,
		};
	}

	return {
		tag: "UnknownError",
		step: "unknown",
		message: String(error),
		status: undefined,
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

		try {
			const result = await Effect.runPromise(
				createTransferEffect({
					env,
					logger,
				}),
			);

			return Response.json({
				ok: true,
				requestId,
				result,
			});
		} catch (error) {
			return Response.json(
				{
					ok: false,
					requestId,
					error: createErrorDetails(error),
				},
				{
					status: 500,
				},
			);
		}
	},
	scheduled(controller, env, context) {
		const { logger } = createRequestLogger({
			trigger: "scheduled",
			cron: controller.cron,
			scheduledTime: new Date(controller.scheduledTime).toISOString(),
		});

		const job = pipe(
			createTransferEffect({
				env,
				logger,
			}),
			Effect.catchAll(() => Effect.void),
		);
		context.waitUntil(Effect.runPromise(job));
	},
} satisfies ExportedHandler<Cloudflare.Env>;
