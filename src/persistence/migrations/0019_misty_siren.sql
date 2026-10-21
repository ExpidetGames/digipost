ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category_routes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_assignee_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "documents_workspace_category_idx";--> statement-breakpoint
DROP INDEX "documents_workspace_assignee_idx";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "category_id";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "category_source";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "assignee_user_id";--> statement-breakpoint
DROP TABLE "categories" CASCADE;--> statement-breakpoint
DROP TABLE "category_routes" CASCADE;