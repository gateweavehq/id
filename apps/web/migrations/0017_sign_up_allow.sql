CREATE TABLE `sign_up_allow` (
	`entry` text PRIMARY KEY NOT NULL,
	`note` text,
	`added_at` integer NOT NULL,
	`added_by` text NOT NULL,
	CONSTRAINT "sign_up_allow_lowercase" CHECK("sign_up_allow"."entry" = lower("sign_up_allow"."entry")),
	CONSTRAINT "sign_up_allow_note" CHECK(length("sign_up_allow"."note") <= 200)
);
