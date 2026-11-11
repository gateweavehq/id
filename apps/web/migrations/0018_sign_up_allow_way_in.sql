-- Custom SQL migration: the owner's list is one more way in. "Who may make an account" in docs/architecture.md.
--
-- An address on the list, or at a listed domain (exactly that domain, not its subdomains), may make an
-- account while sign-up is closed. `auth/deployment.ts` asks the same first, to say so in words.
DROP TRIGGER `user_needs_a_way_in`;--> statement-breakpoint
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND EXISTS (SELECT 1 FROM `user`)
	AND NOT EXISTS (
		SELECT 1 FROM `sign_up_allow`
		WHERE `entry` = lower(new.`email`)
			OR `entry` = '@' || substr(lower(new.`email`), instr(lower(new.`email`), '@') + 1)
	)
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
END;--> statement-breakpoint
-- The list is the owner's to keep short, and the page searches it, so it stops at 5,000 entries whatever
-- writes to it. `MAX_ALLOW_ENTRIES` in src/lib/allow-entry.ts says the same.
CREATE TRIGGER `sign_up_allow_is_capped`
BEFORE INSERT ON `sign_up_allow`
WHEN (SELECT count(*) FROM `sign_up_allow`) >= 5000
BEGIN
	SELECT RAISE(ABORT, 'the sign-up list is full');
END;
