CREATE TABLE "payment_arbiter_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"best_document_id" text,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_arbiter_answers_transaction_key" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "payment_arbiter_answers" ADD CONSTRAINT "payment_arbiter_answers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_arbiter_answers" ADD CONSTRAINT "payment_arbiter_answers_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_arbiter_answers_workspace_idx" ON "payment_arbiter_answers" USING btree ("workspace_id");