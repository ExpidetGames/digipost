CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "categories_workspace_key_key" UNIQUE NULLS NOT DISTINCT("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"original_file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"page_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"searchable_pdf_key" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error_code" text,
	"ocr_text" text,
	"ocr_blocks" jsonb,
	"title" text,
	"sender" text,
	"document_date" date,
	"summary" text,
	"category_id" uuid,
	"category_source" text,
	"assignee_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS ((
        setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(sender, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(original_file_name, '')), 'B') ||
        setweight(to_tsvector('german', coalesce(ocr_text, '')), 'C')
      )) STORED,
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('uploaded', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "quota_package_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"package_key" text NOT NULL,
	"extra_documents" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"period" date NOT NULL,
	"purchased_by_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_monthly_usage" (
	"workspace_id" uuid NOT NULL,
	"period" date NOT NULL,
	"documents_created" integer DEFAULT 0 NOT NULL,
	"warned_total_at" timestamp with time zone,
	"warned_monthly_at" timestamp with time zone,
	CONSTRAINT "workspace_monthly_usage_workspace_id_period_pk" PRIMARY KEY("workspace_id","period")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_package_purchases" ADD CONSTRAINT "quota_package_purchases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_package_purchases" ADD CONSTRAINT "quota_package_purchases_purchased_by_user_id_user_id_fk" FOREIGN KEY ("purchased_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_monthly_usage" ADD CONSTRAINT "workspace_monthly_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_workspace_created_idx" ON "documents" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_workspace_category_idx" ON "documents" USING btree ("workspace_id","category_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_assignee_idx" ON "documents" USING btree ("workspace_id","assignee_user_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_status_idx" ON "documents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "documents_search_vector_idx" ON "documents" USING gin ("search_vector");