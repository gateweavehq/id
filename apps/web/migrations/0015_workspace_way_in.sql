-- Custom SQL migration: "Who owns a deployment" in docs/architecture.md.
--
-- A workspace made while sign-up was open is its maker's, and closing sign-up has to stop it letting people
-- in. So a workspace's invitation is a way in only from a workspace the owner runs. `auth/deployment.ts` asks
-- the same first.
DROP TRIGGER `user_needs_a_way_in`;--> statement-breakpoint
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND EXISTS (SELECT 1 FROM `user`)
	AND NOT EXISTS (
		SELECT 1 FROM `deployment_invitation`
		WHERE `email` = lower(new.`email`) AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
	)
	AND NOT EXISTS (
		SELECT 1 FROM `invitation`
		JOIN `member` ON `member`.`organization_id` = `invitation`.`organization_id`
		WHERE `invitation`.`email` = lower(new.`email`)
			AND `invitation`.`status` = 'pending'
			AND `invitation`.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
			AND `member`.`user_id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
			AND `member`.`role` IN ('owner', 'admin')
	)
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;
