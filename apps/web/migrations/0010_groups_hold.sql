-- Custom SQL migration: what holds however a group comes to change.
--
-- The tables in the last migration hold a person and a group, or an app and a group, to one workspace
-- with foreign keys over two columns. The parents' side of those is in these two indexes, on tables
-- that are generated.
CREATE UNIQUE INDEX `member_id_organization_unique` ON `member` (`id`,`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClient_clientId_referenceId_unique` ON `oauth_client` (`client_id`,`reference_id`);--> statement-breakpoint
-- An app that names no group admits every member, so an app's last group going with nobody having chosen
-- that would open the app to everyone. A group an app names therefore stays until an admin changes the
-- app, which also means deleting a group never changes who can use anything. A workspace being deleted
-- has gone by the time its groups follow, and they are free to go.
CREATE TRIGGER `group_an_app_names_stays`
BEFORE DELETE ON `workspace_group`
WHEN EXISTS (SELECT 1 FROM `workspace_app_group` WHERE `group_id` = old.`id`)
	AND EXISTS (SELECT 1 FROM `organization` WHERE `id` = old.`organization_id`)
BEGIN
	SELECT RAISE(ABORT, 'a group an app names cannot be deleted');
END;--> statement-breakpoint
-- Someone taken out of a group loses the apps it opened for them at once, unless another of their groups
-- opens the same app. The check for who may sign in would stop them at their next token, but an access
-- token already issued lasts up to an hour. Their consent goes as well: let back in, they are asked
-- again, and a token of theirs that was on its way goes as it arrives (`access_token_needs_consent`).
-- Someone leaving the workspace has no row in `member` by now, and `member_delete_ends_app_access` has
-- this for every app of the workspace.
CREATE TRIGGER `group_member_delete_ends_app_access`
AFTER DELETE ON `workspace_group_member`
BEGIN
	DELETE FROM `oauth_access_token`
	WHERE `user_id` = (SELECT `user_id` FROM `member` WHERE `id` = old.`member_id`)
		AND `client_id` IN (
			SELECT `opened`.`client_id` FROM `workspace_app_group` AS `opened`
			WHERE `opened`.`group_id` = old.`group_id`
				AND NOT EXISTS (
					SELECT 1 FROM `workspace_app_group` AS `other`
					INNER JOIN `workspace_group_member` AS `held` ON `held`.`group_id` = `other`.`group_id`
					WHERE `other`.`client_id` = `opened`.`client_id` AND `held`.`member_id` = old.`member_id`
				)
		);
	DELETE FROM `oauth_refresh_token`
	WHERE `user_id` = (SELECT `user_id` FROM `member` WHERE `id` = old.`member_id`)
		AND `client_id` IN (
			SELECT `opened`.`client_id` FROM `workspace_app_group` AS `opened`
			WHERE `opened`.`group_id` = old.`group_id`
				AND NOT EXISTS (
					SELECT 1 FROM `workspace_app_group` AS `other`
					INNER JOIN `workspace_group_member` AS `held` ON `held`.`group_id` = `other`.`group_id`
					WHERE `other`.`client_id` = `opened`.`client_id` AND `held`.`member_id` = old.`member_id`
				)
		);
	DELETE FROM `oauth_consent`
	WHERE `user_id` = (SELECT `user_id` FROM `member` WHERE `id` = old.`member_id`)
		AND `client_id` IN (
			SELECT `opened`.`client_id` FROM `workspace_app_group` AS `opened`
			WHERE `opened`.`group_id` = old.`group_id`
				AND NOT EXISTS (
					SELECT 1 FROM `workspace_app_group` AS `other`
					INNER JOIN `workspace_group_member` AS `held` ON `held`.`group_id` = `other`.`group_id`
					WHERE `other`.`client_id` = `opened`.`client_id` AND `held`.`member_id` = old.`member_id`
				)
		);
END;--> statement-breakpoint
-- Apps can ask for the new scope. Only the server writes this column, and every workspace's app has this
-- list. An app that does not ask gets nothing new, and first-party apps keep what they have.
UPDATE `oauth_client`
SET `scopes` = '["openid","profile","email","offline_access","groups"]'
WHERE `reference_id` IS NOT NULL;
