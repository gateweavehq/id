-- Custom SQL migration: "Who owns a deployment" in docs/architecture.md.
--
-- Deployments that already have accounts keep taking new ones, with their oldest account as the owner,
-- so that nobody finds sign-up closed by an upgrade. A new one starts closed, and its first account owns it.
INSERT INTO `deployment` (`id`, `owner_id`, `sign_up`, `updated_at`)
SELECT 1,
	(SELECT `id` FROM `user` ORDER BY `created_at`, `id` LIMIT 1),
	CASE WHEN EXISTS (SELECT 1 FROM `user`) THEN 'open' ELSE 'closed' END,
	cast(unixepoch('subsecond') * 1000 as integer);--> statement-breakpoint
-- However an account comes to be made, on a closed server it needs a way in: the owner's invitation or a
-- workspace's. `auth/deployment.ts` asks the same first, to say so in words; this is what holds if a path
-- that makes accounts ever forgets to ask. Missing the row counts as closed.
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
		WHERE `email` = lower(new.`email`)
			AND `status` = 'pending'
			AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
	)
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;--> statement-breakpoint
-- Whoever gets there first owns the server, and D1 runs writes one at a time, so there is only ever one.
CREATE TRIGGER `first_account_owns_deployment`
AFTER INSERT ON `user`
WHEN (SELECT `owner_id` FROM `deployment` WHERE `id` = 1) IS NULL
	AND NOT EXISTS (SELECT 1 FROM `user` WHERE `id` <> new.`id`)
BEGIN
	UPDATE `deployment`
	SET `owner_id` = new.`id`, `updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;--> statement-breakpoint
-- The owner's invitation is for making one account. Left there, it would be a way back in for the address
-- after that account has gone.
CREATE TRIGGER `account_uses_up_invitation`
AFTER INSERT ON `user`
BEGIN
	DELETE FROM `deployment_invitation` WHERE `email` = lower(new.`email`);
END;
