CREATE TABLE "intake_source_fingerprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"document_kind" text NOT NULL,
	"platform" text,
	"column_mapping" jsonb NOT NULL,
	"amount_sign" jsonb,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"use_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "intake_source_fingerprints_workspace_fingerprint_key" UNIQUE("workspace_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_hash" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" text DEFAULT 'letter' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "intake_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "intake_result" jsonb;--> statement-breakpoint
ALTER TABLE "intake_source_fingerprints" ADD CONSTRAINT "intake_source_fingerprints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_source_fingerprints" ADD CONSTRAINT "intake_source_fingerprints_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_workspace_file_hash_idx" ON "documents" USING btree ("workspace_id","file_hash");--> statement-breakpoint
CREATE INDEX "documents_workspace_kind_idx" ON "documents" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "documents_workspace_intake_status_idx" ON "documents" USING btree ("workspace_id","intake_status");