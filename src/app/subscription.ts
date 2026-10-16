import { Clock, Duration, Effect, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { Message } from "./message";
import type { Model } from "./model";
import { isPolling } from "./update";

const POLL_INTERVAL = Duration.seconds(2);

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	poll: entry(
		{ isPolling: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isPolling: model.screen._tag === "Unlocked" && isPolling(model.screen.library),
			}),
			dependenciesToStream: ({ isPolling }) =>
				Stream.when(
					Stream.tick(POLL_INTERVAL).pipe(
						Stream.drop(1),
						Stream.mapEffect(() => Clock.currentTimeMillis),
						Stream.map((now) => Message.TickedPoll({ now })),
					),
					Effect.sync(() => isPolling),
				),
		},
	),
}));
