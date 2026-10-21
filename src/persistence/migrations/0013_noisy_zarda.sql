CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"iban" text,
	"bic" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"holder" text,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_workspace_iban_key" UNIQUE("workspace_id","iban"),
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" in ('bank', 'clearing'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_document_id" uuid,
	"statement_from" date,
	"statement_to" date,
	"opening_balance_cents" integer,
	"closing_balance_cents" integer,
	"rows_total" integer NOT NULL,
	"rows_imported" integer NOT NULL,
	"rows_duplicate" integer NOT NULL,
	"balance_mismatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_source_document_key" UNIQUE("source_document_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount_cents" integer NOT NULL,
	"currency" text,
	"credit_debit" text NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" text,
	"counterparty_bic" text,
	"remittance_text" text,
	"end_to_end_id" text,
	"mandate_id" text,
	"creditor_id" text,
	"bank_tx_code" text,
	"bank_reference" text,
	"idempotency_key" text NOT NULL,
	"import_batch_id" uuid,
	"source_document_id" uuid,
	"transfer_group_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_account_idempotency_key" UNIQUE("account_id","idempotency_key"),
	CONSTRAINT "transactions_credit_debit_check" CHECK ("transactions"."credit_debit" in ('credit', 'debit'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_workspace_idx" ON "accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "import_batches_workspace_account_idx" ON "import_batches" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "transactions_workspace_booking_date_idx" ON "transactions" USING btree ("workspace_id","booking_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_account_booking_date_idx" ON "transactions" USING btree ("account_id","booking_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_workspace_counterparty_iban_idx" ON "transactions" USING btree ("workspace_id","counterparty_iban");--> statement-breakpoint
CREATE INDEX "transactions_workspace_amount_idx" ON "transactions" USING btree ("workspace_id","amount_cents");