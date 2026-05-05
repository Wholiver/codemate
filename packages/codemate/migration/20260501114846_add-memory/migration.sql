CREATE TABLE `memory` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`summary` text,
	`version` integer DEFAULT 1 NOT NULL,
	`migrated_to` text,
	`deprecated` integer DEFAULT false NOT NULL,
	`vitality` real DEFAULT 1 NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_session_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_chunk` (
	`id` text PRIMARY KEY,
	`memory_id` text NOT NULL,
	`content` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_chunk_memory_id_memory_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_chunk_vec` (
	`memory_id` text PRIMARY KEY,
	`embedding` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_memory_chunk_vec_memory_id_memory_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_alias` (
	`alias` text PRIMARY KEY,
	`target_domain` text NOT NULL,
	`target_path` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_alias_target_idx` ON `memory_alias` (`target_domain`,`target_path`);--> statement-breakpoint
CREATE INDEX `memory_chunk_memory_idx` ON `memory_chunk` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_chunk_vec_memory_idx` ON `memory_chunk_vec` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_project_idx` ON `memory` (`project_id`);--> statement-breakpoint
CREATE INDEX `memory_domain_idx` ON `memory` (`domain`);--> statement-breakpoint
CREATE INDEX `memory_domain_path_idx` ON `memory` (`domain`,`path`);--> statement-breakpoint
CREATE INDEX `memory_vitality_idx` ON `memory` (`vitality`);--> statement-breakpoint
CREATE INDEX `memory_migrated_to_idx` ON `memory` (`migrated_to`);
