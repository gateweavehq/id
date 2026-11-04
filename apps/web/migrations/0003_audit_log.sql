CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`user_id` text,
	`app` text,
	`ip` text,
	`device` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_event_user_at_idx` ON `audit_event` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_event_at_idx` ON `audit_event` (`at`);