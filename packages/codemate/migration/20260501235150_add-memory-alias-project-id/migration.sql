ALTER TABLE `memory_alias` ADD `project_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `memory_alias_project_idx` ON `memory_alias` (`project_id`);