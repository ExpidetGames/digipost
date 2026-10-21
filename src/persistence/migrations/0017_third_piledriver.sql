ALTER TABLE "workspaces" ADD COLUMN "company_aliases" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_ibans" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_tax_number" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_register_court" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_register_number" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_profile_text" text;