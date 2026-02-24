CREATE TABLE `execution_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`level` enum('info','success','warning','error') NOT NULL DEFAULT 'info',
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`status` enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
	`triggeredBy` enum('manual','scheduled') NOT NULL DEFAULT 'manual',
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	`durationMs` int,
	`summary` json,
	`errorMessage` text,
	CONSTRAINT `execution_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `nalanda_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`nalandaUsername` varchar(320) NOT NULL,
	`nalandaPasswordEnc` text NOT NULL,
	`monthsBack` int NOT NULL DEFAULT 6,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `nalanda_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedule_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`cronExpression` varchar(100) NOT NULL DEFAULT '0 8 * * 1-5',
	`timezone` varchar(64) NOT NULL DEFAULT 'Europe/Madrid',
	`nextRunAt` timestamp,
	`lastRunAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `schedule_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `schedule_config_userId_unique` UNIQUE(`userId`)
);
