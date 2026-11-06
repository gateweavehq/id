-- Custom SQL migration: a server keeps whoever runs it.
--
-- The owner's row going would empty `deployment.owner_id`, and on a closed server that leaves nobody able
-- to open sign-up, invite anyone or make a workspace, short of SQL. So their account stays until someone
-- else runs the server, however a request comes to try.
CREATE TRIGGER `deployment_keeps_its_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
BEGIN
	SELECT RAISE(ABORT, 'a server must keep its owner');
END;
