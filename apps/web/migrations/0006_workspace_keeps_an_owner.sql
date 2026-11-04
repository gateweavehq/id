-- Custom SQL migration: what holds however a row comes to change.
--
-- The plugin counts a workspace's owners and then acts, in separate queries, so two owners leaving at
-- the same moment could each see the other still there. A workspace with no owner has nobody who can
-- fix it, so the database refuses the change that would make one. A workspace being deleted has gone
-- by the time its members follow, and they are free to go.
--
-- Someone also joins a workspace only once. An invitation can only be taken once, and this holds if
-- anything else ever adds a member.
CREATE UNIQUE INDEX `member_organization_user_unique` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE TRIGGER `member_delete_keeps_an_owner`
BEFORE DELETE ON `member`
WHEN old.`role` = 'owner'
	AND EXISTS (SELECT 1 FROM `organization` WHERE `id` = old.`organization_id`)
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND `role` = 'owner') <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;--> statement-breakpoint
CREATE TRIGGER `member_update_keeps_an_owner`
BEFORE UPDATE OF `role` ON `member`
WHEN old.`role` = 'owner'
	AND new.`role` <> 'owner'
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND `role` = 'owner') <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;
