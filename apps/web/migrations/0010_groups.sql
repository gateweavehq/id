CREATE TABLE `workspace_app_group` (
	`client_id` text NOT NULL,
	`group_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `group_id`),
	FOREIGN KEY (`client_id`,`organization_id`) REFERENCES `oauth_client`(`client_id`,`reference_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`,`organization_id`) REFERENCES `workspace_group`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_app_group_group_idx` ON `workspace_app_group` (`group_id`);--> statement-breakpoint
CREATE INDEX `workspace_app_group_organization_idx` ON `workspace_app_group` (`organization_id`);--> statement-breakpoint
CREATE TABLE `workspace_group` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`comparable_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_group_id_organization_unique` ON `workspace_group` (`id`,`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_group_name_unique` ON `workspace_group` (`organization_id`,`comparable_name`);--> statement-breakpoint
CREATE TABLE `workspace_group_member` (
	`group_id` text NOT NULL,
	`member_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `member_id`),
	FOREIGN KEY (`group_id`,`organization_id`) REFERENCES `workspace_group`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_group_member_member_idx` ON `workspace_group_member` (`member_id`);--> statement-breakpoint
CREATE INDEX `workspace_group_member_organization_idx` ON `workspace_group_member` (`organization_id`);