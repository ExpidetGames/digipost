CREATE TABLE "document_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"kind" text NOT NULL,
	"confidence" real NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text,
	"matched_by" text NOT NULL,
	"allocated_amount_cents" integer NOT NULL,
	"arbiter_cache_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	CONSTRAINT "document_transactions_document_transaction_key" UNIQUE("document_id","transaction_id"),
	CONSTRAINT "document_transactions_status_check" CHECK ("document_transactions"."status" in ('suggested', 'confirmed', 'rejected')),
	CONSTRAINT "document_transactions_kind_check" CHECK ("document_transactions"."kind" in ('exact', 'skonto', 'partial', 'collective', 'ai', 'manual')),
	CONSTRAINT "document_transactions_matched_by_check" CHECK ("document_transactions"."matched_by" in ('auto', 'ai', 'user'))
);
--> statement-breakpoint
CREATE TABLE "payment_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"counterparty_name_normalized" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"learned_from_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_aliases_workspace_name_key" UNIQUE("workspace_id","counterparty_name_normalized")
);
--> statement-breakpoint
CREATE TABLE "payment_no_document_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"counterparty_name_normalized" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_no_document_rules_workspace_name_key" UNIQUE("workspace_id","counterparty_name_normalized")
);
--> statement-breakpoint
CREATE TABLE "payment_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"rejected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_rejections_document_transaction_key" UNIQUE("document_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "payment_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "no_document_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_transactions" ADD CONSTRAINT "document_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_transactions" ADD CONSTRAINT "document_transactions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_transactions" ADD CONSTRAINT "document_transactions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_transactions" ADD CONSTRAINT "document_transactions_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_aliases" ADD CONSTRAINT "payment_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_aliases" ADD CONSTRAINT "payment_aliases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_aliases" ADD CONSTRAINT "payment_aliases_learned_from_user_id_user_id_fk" FOREIGN KEY ("learned_from_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_no_document_rules" ADD CONSTRAINT "payment_no_document_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_no_document_rules" ADD CONSTRAINT "payment_no_document_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_rejections" ADD CONSTRAINT "payment_rejections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_rejections" ADD CONSTRAINT "payment_rejections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_rejections" ADD CONSTRAINT "payment_rejections_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_rejections" ADD CONSTRAINT "payment_rejections_rejected_by_user_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_transactions_workspace_status_idx" ON "document_transactions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "document_transactions_transaction_idx" ON "document_transactions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_payment_status_idx" ON "documents" USING btree ("workspace_id","payment_status");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_payment_status_check" CHECK ("documents"."payment_status" in ('open', 'partially_paid', 'paid', 'overdue', 'settled', 'no_document_needed', 'not_applicable'));