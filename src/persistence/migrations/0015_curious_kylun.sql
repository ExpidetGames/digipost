CREATE TABLE "settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"clearing_account_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"transaction_id" uuid,
	"type" text NOT NULL,
	"external_line_id" text NOT NULL,
	"gross_cents" integer,
	"fee_cents" integer,
	"net_cents" integer,
	"currency" text,
	"booking_date" date,
	"payout_id" text,
	"charge_id" text,
	"invoice_id" text,
	"customer_name" text,
	"customer_email" text,
	"product_name" text,
	"country_of_sale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_lines_document_external_key" UNIQUE("source_document_id","external_line_id"),
	CONSTRAINT "settlement_lines_type_check" CHECK ("settlement_lines"."type" in ('revenue', 'fee', 'refund', 'payout', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_clearing_account_id_accounts_id_fk" FOREIGN KEY ("clearing_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlement_lines_workspace_idx" ON "settlement_lines" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_clearing_account_idx" ON "settlement_lines" USING btree ("clearing_account_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_workspace_type_idx" ON "settlement_lines" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "settlement_lines_account_type_booking_date_idx" ON "settlement_lines" USING btree ("clearing_account_id","type","booking_date");--> statement-breakpoint
CREATE INDEX "documents_workspace_platform_idx" ON "documents" USING btree ("workspace_id","platform");