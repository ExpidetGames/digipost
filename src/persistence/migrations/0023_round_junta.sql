CREATE TABLE "inbound_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_email_id" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text,
	"message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"reason_code" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_emails_attempts_check" CHECK ("inbound_emails"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_intake_allowed_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_intake_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sender_policy" text DEFAULT 'allowlist' NOT NULL,
	"token_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_intake_settings_workspaceId_unique" UNIQUE("workspace_id"),
	CONSTRAINT "mail_intake_settings_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_intake_allowed_senders" ADD CONSTRAINT "mail_intake_allowed_senders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_intake_allowed_senders" ADD CONSTRAINT "mail_intake_allowed_senders_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_intake_settings" ADD CONSTRAINT "mail_intake_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_emails_provider_email_workspace_key" ON "inbound_emails" USING btree ("provider_email_id","workspace_id");--> statement-breakpoint
CREATE INDEX "inbound_emails_workspace_received_idx" ON "inbound_emails" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "inbound_emails_workspace_notified_idx" ON "inbound_emails" USING btree ("workspace_id","reason_code","notified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_intake_allowed_senders_workspace_value_key" ON "mail_intake_allowed_senders" USING btree ("workspace_id","value");