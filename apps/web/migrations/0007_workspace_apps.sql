-- Custom SQL migration: what holds however someone comes to leave a workspace, or a workspace to go.
--
-- Someone out of a workspace loses its apps at once. The check for who may sign in would stop them at
-- their next token, but an access token already issued lasts up to an hour, so what they hold goes when
-- they do. Their consent goes as well: invited back, they are asked again.
--
-- An app has no foreign key to its workspace, because `reference_id` is the provider's column and can
-- name anything. So a workspace's apps are deleted here, and their tokens and consents follow by their
-- own foreign keys.
CREATE INDEX `oauthClient_referenceId_idx` ON `oauth_client` (`reference_id`);--> statement-breakpoint
CREATE TRIGGER `member_delete_ends_app_access`
AFTER DELETE ON `member`
BEGIN
	DELETE FROM `oauth_access_token`
	WHERE `user_id` = old.`user_id`
		AND `client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` = old.`organization_id`);
	DELETE FROM `oauth_refresh_token`
	WHERE `user_id` = old.`user_id`
		AND `client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` = old.`organization_id`);
	DELETE FROM `oauth_consent`
	WHERE `user_id` = old.`user_id`
		AND `client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` = old.`organization_id`);
END;--> statement-breakpoint
CREATE TRIGGER `organization_delete_removes_apps`
AFTER DELETE ON `organization`
BEGIN
	DELETE FROM `oauth_client` WHERE `reference_id` = old.`id`;
END;
