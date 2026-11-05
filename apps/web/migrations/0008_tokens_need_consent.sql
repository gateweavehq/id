-- Custom SQL migration: a workspace's app holds only what someone's standing yes gave it.
--
-- The token hook reads the consent before the provider writes the tokens, so a take-back, or someone
-- leaving, can land in between. Tokens written after that have no consent and no row on anyone's list,
-- so nobody could see them or end them. So a token with no consent goes as it arrives. The app may
-- already have been told of it, and it does nothing, since every use of a token reads its row. The ID
-- token in that answer still arrives, and says only what the app was allowed a moment before.
--
-- A yes that changes ends what came of the old one, so what the account page lists is what the app
-- holds. The provider never lowers a token's scopes by itself, and an app could otherwise ask for less
-- to look harmless on that page while it kept what it had. The tokens the new yes buys come after this.
--
-- First-party apps are not asked, so these leave them alone: they have no consent to need.
--
-- Nothing in the provider stops two answers at once from making two rows, and the account page would
-- then list the app twice, one of them wrong. So there is one row for each person and app, the latest.
DELETE FROM `oauth_consent`
WHERE `user_id` IS NOT NULL
	AND `id` NOT IN (
		SELECT `id` FROM (
			SELECT `id`, row_number() OVER (
				PARTITION BY `user_id`, `client_id` ORDER BY `updated_at` DESC, `id`
			) AS `latest`
			FROM `oauth_consent`
			WHERE `user_id` IS NOT NULL
		)
		WHERE `latest` = 1
	);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthConsent_userId_clientId_unique` ON `oauth_consent` (`user_id`, `client_id`);--> statement-breakpoint
CREATE TRIGGER `access_token_needs_consent`
AFTER INSERT ON `oauth_access_token`
WHEN new.`client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` IS NOT NULL)
	AND NOT EXISTS (
		SELECT 1 FROM `oauth_consent` WHERE `user_id` = new.`user_id` AND `client_id` = new.`client_id`
	)
BEGIN
	DELETE FROM `oauth_access_token` WHERE `id` = new.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `refresh_token_needs_consent`
AFTER INSERT ON `oauth_refresh_token`
WHEN new.`client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` IS NOT NULL)
	AND NOT EXISTS (
		SELECT 1 FROM `oauth_consent` WHERE `user_id` = new.`user_id` AND `client_id` = new.`client_id`
	)
BEGIN
	DELETE FROM `oauth_refresh_token` WHERE `id` = new.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `changed_consent_ends_tokens`
AFTER UPDATE OF `scopes` ON `oauth_consent`
WHEN old.`scopes` <> new.`scopes`
	AND new.`client_id` IN (SELECT `client_id` FROM `oauth_client` WHERE `reference_id` IS NOT NULL)
BEGIN
	DELETE FROM `oauth_access_token` WHERE `user_id` = new.`user_id` AND `client_id` = new.`client_id`;
	DELETE FROM `oauth_refresh_token` WHERE `user_id` = new.`user_id` AND `client_id` = new.`client_id`;
END;
