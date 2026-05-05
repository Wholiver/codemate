CREATE TABLE `changelog` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`summary` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `changelog_project_idx` ON `changelog` (`project_id`);--> statement-breakpoint
CREATE INDEX `changelog_session_idx` ON `changelog` (`session_id`);