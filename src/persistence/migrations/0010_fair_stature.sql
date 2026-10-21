CREATE TABLE "contact_change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"document_id" uuid,
	"field" text NOT NULL,
	"current_value" text,
	"proposed_value" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	CONSTRAINT "contact_change_proposals_status_check" CHECK ("contact_change_proposals"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_form" text,
	"address_line1" text,
	"address_line2" text,
	"postal_code" text,
	"city" text,
	"country" text DEFAULT 'DE',
	"vat_id" text,
	"tax_number" text,
	"register_court" text,
	"register_number" text,
	"leitweg_id" text,
	"iban" text,
	"bic" text,
	"bank_name" text,
	"account_holder" text,
	"sepa_creditor_id" text,
	"phone" text,
	"email" text,
	"website" text,
	"contact_person" text,
	"customer_number" text,
	"supplier_number" text,
	"payment_terms_days" integer,
	"relation_type" text,
	"notes" text,
	"source" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"first_seen_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name_normalized" text NOT NULL,
	"vat_id_normalized" text,
	"iban_normalized" text,
	CONSTRAINT "contacts_relation_type_check" CHECK ("contacts"."relation_type" is null or "contacts"."relation_type" in ('supplier', 'customer', 'authority', 'insurance', 'bank', 'other')),
	CONSTRAINT "contacts_source_check" CHECK ("contacts"."source" in ('auto', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "document_contacts" (
	"document_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_contacts_document_id_contact_id_role_pk" PRIMARY KEY("document_id","contact_id","role"),
	CONSTRAINT "document_contacts_role_check" CHECK ("document_contacts"."role" in ('sender', 'recipient', 'on_behalf_of', 'mentioned'))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_address_line1" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_address_line2" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_postal_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_city" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_country" text DEFAULT 'DE';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "company_vat_id" text;--> statement-breakpoint
ALTER TABLE "contact_change_proposals" ADD CONSTRAINT "contact_change_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_change_proposals" ADD CONSTRAINT "contact_change_proposals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_change_proposals" ADD CONSTRAINT "contact_change_proposals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_change_proposals" ADD CONSTRAINT "contact_change_proposals_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_verified_by_user_id_user_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_first_seen_document_id_documents_id_fk" FOREIGN KEY ("first_seen_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_contacts" ADD CONSTRAINT "document_contacts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_contacts" ADD CONSTRAINT "document_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_change_proposals_workspace_status_idx" ON "contact_change_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "contact_change_proposals_contact_idx" ON "contact_change_proposals" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_workspace_vat_normalized_key" ON "contacts" USING btree ("workspace_id","vat_id_normalized") WHERE "contacts"."vat_id_normalized" is not null;--> statement-breakpoint
CREATE INDEX "contacts_workspace_iban_normalized_idx" ON "contacts" USING btree ("workspace_id","iban_normalized");--> statement-breakpoint
CREATE INDEX "contacts_workspace_name_normalized_postal_idx" ON "contacts" USING btree ("workspace_id","name_normalized","postal_code");--> statement-breakpoint
CREATE INDEX "contacts_workspace_name_idx" ON "contacts" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "document_contacts_contact_idx" ON "document_contacts" USING btree ("contact_id");