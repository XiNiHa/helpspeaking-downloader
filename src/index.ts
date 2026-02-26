import { Effect, pipe } from "effect";
import { createDebugLogger } from "./logging";
import { runTransferWorkflow } from "./workflow";

export default {
	scheduled(controller, env, context) {
		const requestId = crypto.randomUUID();
		const startedAt = new Date().toISOString();
		const logger = createDebugLogger(requestId);
		logger("handler.accepted", "Accepted transfer request", {
			cron: controller.cron,
			scheduledTime: new Date(controller.scheduledTime).toISOString(),
			startedAt,
		});

		const job = pipe(
			runTransferWorkflow({
				env,
				logger,
			}),
			Effect.tap((result) =>
				Effect.sync(() => {
					logger("handler.completed", "Transfer finished", result);
				}),
			),
			Effect.catchAll((error) =>
				Effect.sync(() => {
					logger("handler.failed", "Transfer failed", {
						tag: error._tag,
						step: error.step,
						message: error.message,
						status: error.status,
					});
				}),
			),
		);
		context.waitUntil(Effect.runPromise(job));
	},
} satisfies ExportedHandler<Cloudflare.Env>;
