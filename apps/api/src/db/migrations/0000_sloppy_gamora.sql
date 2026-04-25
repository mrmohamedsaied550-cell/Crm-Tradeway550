CREATE TABLE `activities` (
	`id` varchar(24) NOT NULL,
	`enrollment_id` varchar(24) NOT NULL,
	`actor_id` varchar(24),
	`type` enum('call','note','sms','whatsapp','email','stage_change','status_change','assignment_change','approval_request','approval_response','document_upload','field_update','sheet_sync','system_event','created') NOT NULL,
	`summary` varchar(500),
	`data` json,
	`duration_sec` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaign_routing_state` (
	`campaign_id` varchar(24) NOT NULL,
	`last_assigned_user_id` varchar(24),
	`total_assigned` varchar(16) NOT NULL DEFAULT '0',
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `campaign_routing_state_campaign_id` PRIMARY KEY(`campaign_id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` varchar(24) NOT NULL,
	`name` varchar(160) NOT NULL,
	`code` varchar(64) NOT NULL,
	`platform` enum('meta','tiktok','google','referral','manual','sheet','other') NOT NULL,
	`company_country_id` varchar(24) NOT NULL,
	`budget` decimal(12,2),
	`currency` varchar(3),
	`routing_mode` enum('round_robin','percentage','capacity','performance','manual','hybrid') NOT NULL DEFAULT 'round_robin',
	`routing_config` json,
	`webhook_secret` varchar(64),
	`external_campaign_id` varchar(120),
	`is_active` boolean NOT NULL DEFAULT true,
	`starts_at` timestamp,
	`ends_at` timestamp,
	`created_by` varchar(24),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`),
	CONSTRAINT `campaigns_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` varchar(24) NOT NULL,
	`code` varchar(32) NOT NULL,
	`name_ar` varchar(120) NOT NULL,
	`name_en` varchar(120) NOT NULL,
	`logo_url` varchar(500),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `companies_id` PRIMARY KEY(`id`),
	CONSTRAINT `companies_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `company_countries` (
	`id` varchar(24) NOT NULL,
	`company_id` varchar(24) NOT NULL,
	`country_code` varchar(2) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `company_countries_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_company_country` UNIQUE(`company_id`,`country_code`)
);
--> statement-breakpoint
CREATE TABLE `countries` (
	`code` varchar(2) NOT NULL,
	`name_ar` varchar(80) NOT NULL,
	`name_en` varchar(80) NOT NULL,
	`currency` varchar(3) NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`flag_emoji` varchar(16),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `countries_code` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` varchar(24) NOT NULL,
	`full_name` varchar(160) NOT NULL,
	`phone` varchar(32) NOT NULL,
	`whatsapp` varchar(32),
	`email` varchar(191),
	`city` varchar(80),
	`country_code` varchar(2) NOT NULL,
	`vehicle_type` enum('car','motorcycle','van','other'),
	`national_id` varchar(32),
	`notes` varchar(1000),
	`deleted_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_contact_phone` UNIQUE(`phone`)
);
--> statement-breakpoint
CREATE TABLE `enrollment_documents` (
	`id` varchar(24) NOT NULL,
	`enrollment_id` varchar(24) NOT NULL,
	`type` enum('national_id','driver_license','vehicle_license','criminal_record','photo','other') NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`file_url` varchar(500) NOT NULL,
	`file_size` varchar(32),
	`mime_type` varchar(64),
	`uploaded_by` varchar(24) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `enrollment_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `enrollments` (
	`id` varchar(24) NOT NULL,
	`contact_id` varchar(24) NOT NULL,
	`company_country_id` varchar(24) NOT NULL,
	`current_stage_id` varchar(24),
	`current_status_id` varchar(24),
	`sub_status` enum('active','waiting_approval','waiting_customer','cold','paused','completed','dropped') NOT NULL DEFAULT 'active',
	`source` varchar(64),
	`source_code` varchar(64),
	`campaign_id` varchar(24),
	`assigned_user_id` varchar(24),
	`assigned_at` timestamp,
	`reject_reason_id` varchar(24),
	`reject_note` varchar(500),
	`next_follow_up_at` timestamp,
	`last_contact_at` timestamp,
	`first_trip_at` timestamp,
	`trips_count` varchar(16),
	`external_ref` varchar(120),
	`metadata` json,
	`deleted_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `enrollments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` varchar(24) NOT NULL,
	`name` varchar(120) NOT NULL,
	`type` enum('sales','activation','driving') NOT NULL DEFAULT 'sales',
	`country_code` varchar(2) NOT NULL,
	`company_id` varchar(24),
	`leader_id` varchar(24),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teams_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(24) NOT NULL,
	`name` varchar(120) NOT NULL,
	`email` varchar(191) NOT NULL,
	`phone` varchar(32),
	`password_hash` varchar(255) NOT NULL,
	`role` enum('super_admin','manager','team_leader','sales_agent') NOT NULL,
	`country_code` varchar(2),
	`team_id` varchar(24),
	`manager_id` varchar(24),
	`is_active` boolean NOT NULL DEFAULT true,
	`is_on_leave` boolean NOT NULL DEFAULT false,
	`daily_lead_cap` int,
	`last_login_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `lead_statuses` (
	`id` varchar(24) NOT NULL,
	`company_country_id` varchar(24),
	`code` varchar(64) NOT NULL,
	`name_ar` varchar(80) NOT NULL,
	`name_en` varchar(80) NOT NULL,
	`color` varchar(32) NOT NULL DEFAULT '#94a3b8',
	`icon` varchar(64),
	`order` int NOT NULL DEFAULT 0,
	`is_active` boolean NOT NULL DEFAULT true,
	`is_terminal` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lead_statuses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reject_reasons` (
	`id` varchar(24) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name_ar` varchar(120) NOT NULL,
	`name_en` varchar(120) NOT NULL,
	`category` varchar(64),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reject_reasons_id` PRIMARY KEY(`id`),
	CONSTRAINT `reject_reasons_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `stages` (
	`id` varchar(24) NOT NULL,
	`company_country_id` varchar(24),
	`code` varchar(64) NOT NULL,
	`name_ar` varchar(80) NOT NULL,
	`name_en` varchar(80) NOT NULL,
	`color` varchar(32) NOT NULL DEFAULT '#3b82f6',
	`icon` varchar(64),
	`team_type` enum('sales','activation','driving','none') NOT NULL DEFAULT 'sales',
	`order` int NOT NULL DEFAULT 0,
	`required_fields` json,
	`approval_required` enum('none','team_leader','manager','admin') NOT NULL DEFAULT 'none',
	`sla_minutes` int,
	`is_active` boolean NOT NULL DEFAULT true,
	`is_terminal` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` varchar(24) NOT NULL,
	`user_id` varchar(24) NOT NULL,
	`refresh_token_hash` varchar(191) NOT NULL,
	`user_agent` varchar(500),
	`ip_address` varchar(64),
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_activity_enrollment` ON `activities` (`enrollment_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_actor` ON `activities` (`actor_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_type` ON `activities` (`type`);--> statement-breakpoint
CREATE INDEX `idx_activity_created` ON `activities` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_campaign_cc` ON `campaigns` (`company_country_id`);--> statement-breakpoint
CREATE INDEX `idx_campaign_platform` ON `campaigns` (`platform`);--> statement-breakpoint
CREATE INDEX `idx_contact_city` ON `contacts` (`city`);--> statement-breakpoint
CREATE INDEX `idx_contact_country` ON `contacts` (`country_code`);--> statement-breakpoint
CREATE INDEX `idx_doc_enrollment` ON `enrollment_documents` (`enrollment_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_contact` ON `enrollments` (`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_cc` ON `enrollments` (`company_country_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_assigned` ON `enrollments` (`assigned_user_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_stage` ON `enrollments` (`current_stage_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_status` ON `enrollments` (`current_status_id`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_followup` ON `enrollments` (`next_follow_up_at`);--> statement-breakpoint
CREATE INDEX `idx_enrollment_campaign` ON `enrollments` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `idx_session_user` ON `user_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_session_token` ON `user_sessions` (`refresh_token_hash`);