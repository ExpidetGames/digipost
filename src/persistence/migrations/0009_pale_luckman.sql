ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_invited_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_package_purchases" DROP CONSTRAINT "quota_package_purchases_purchased_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_tier_changes" DROP CONSTRAINT "workspace_tier_changes_changed_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "invited_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_package_purchases" ALTER COLUMN "purchased_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_tier_changes" ALTER COLUMN "changed_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_package_purchases" ADD CONSTRAINT "quota_package_purchases_purchased_by_user_id_user_id_fk" FOREIGN KEY ("purchased_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tier_changes" ADD CONSTRAINT "workspace_tier_changes_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;