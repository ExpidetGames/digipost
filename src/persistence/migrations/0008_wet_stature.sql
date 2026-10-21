CREATE TABLE "workspace_tier_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"previous_tier" text NOT NULL,
	"new_tier" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_tier_changes" ADD CONSTRAINT "workspace_tier_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tier_changes" ADD CONSTRAINT "workspace_tier_changes_changed_by_user_id_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;