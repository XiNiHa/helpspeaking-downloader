CREATE TABLE `unlock_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`failed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unlock_failures_failed_at_idx` ON `unlock_failures` (`failed_at`);