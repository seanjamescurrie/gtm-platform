CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_number" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"company_type" text NOT NULL,
	"sic_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"incorporated_on" date,
	"ceased_on" date,
	"registered_address" jsonb,
	"ch_etag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_company_number_unique" UNIQUE("company_number")
);
--> statement-breakpoint
CREATE INDEX "companies_sic_codes_idx" ON "companies" USING gin ("sic_codes");