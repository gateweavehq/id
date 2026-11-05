-- Custom SQL migration: what the foreign keys of the next migration stand on.
--
-- Its tables hold a person and a group, or an app and a group, to one workspace with foreign keys over two
-- columns. The parents' side of those is in these two indexes, on tables that are generated. They come
-- first because once those tables exist, without these every delete from `member` or `oauth_client` fails
-- with "foreign key mismatch", so nobody could leave a workspace until the migrations had finished.
CREATE UNIQUE INDEX `member_id_organization_unique` ON `member` (`id`,`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClient_clientId_referenceId_unique` ON `oauth_client` (`client_id`,`reference_id`);
