CREATE TABLE `deployment` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text,
	`sign_up` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "deployment_one_row" CHECK("deployment"."id" = 1),
	CONSTRAINT "deployment_sign_up" CHECK("deployment"."sign_up" IN ('closed', 'open'))
);
--> statement-breakpoint
CREATE TABLE `deployment_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_invitation_email_unique` ON `deployment_invitation` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_invitation_token_hash_unique` ON `deployment_invitation` (`token_hash`);