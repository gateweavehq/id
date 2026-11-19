CREATE TABLE `logout_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`sub` text NOT NULL,
	`sid` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logout_outbox_created_at_idx` ON `logout_outbox` (`created_at`);