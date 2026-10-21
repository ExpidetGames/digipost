ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_userId_unique";--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_key" ON "workspace_members" USING btree ("workspace_id","user_id");