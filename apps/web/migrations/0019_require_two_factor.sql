ALTER TABLE `organization` ADD `require_two_factor` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `session` ADD `sign_in_method` text;