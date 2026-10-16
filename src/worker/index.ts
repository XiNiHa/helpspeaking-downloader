import { Effect } from "effect";
import { apiHandler } from "./api";
import { Db } from "./db";
import { startRun } from "./runs";

export { Transcoder } from "./transcoder";
export { RunWorkflow } from "./workflow";

export default {
	fetch: (request) => apiHandler(request),
	scheduled: (_controller, _env, ctx) => {
		ctx.waitUntil(
			Effect.runPromise(
				startRun("cron").pipe(
					Effect.catchTag("RunAlreadyActive", () =>
						Effect.logInfo("Skipping the scheduled run because another run is active"),
					),
					Effect.provide(Db.layer),
				),
			),
		);
	},
} satisfies ExportedHandler<Env>;
