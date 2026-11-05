-- Custom SQL migration: who added a workspace's app.
--
-- An app belongs to its workspace, so it stays when the admin who added it leaves. If they run its host,
-- the members who agreed to it can still reach it, so the app list says who added each app and whether
-- they are still in the workspace. Only their own activity log said so before, and only for 90 days.
--
-- `oauth_client` is the provider's table, and the provider never writes this column: its client endpoints
-- are closed, and its updates name the columns they change. There is no foreign key, as in the audit
-- log, so it outlasts the person. Apps added before this have none.
ALTER TABLE `oauth_client` ADD `added_by` text;
