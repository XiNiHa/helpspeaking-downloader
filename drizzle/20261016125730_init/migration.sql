CREATE TABLE `lessons` (
	`id` text PRIMARY KEY,
	`tutor` text,
	`status` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer,
	`duration` real,
	`phase` text,
	`progress` real,
	`phase_started_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY,
	`trigger` text NOT NULL,
	`lesson_id` text,
	`status` text NOT NULL,
	`step` text,
	`error` text,
	`screenshot` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `lessons_status_idx` ON `lessons` (`status`);--> statement-breakpoint
CREATE INDEX `runs_started_at_idx` ON `runs` (`started_at`);