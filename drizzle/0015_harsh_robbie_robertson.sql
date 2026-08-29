CREATE TYPE "public"."application_question" AS ENUM('SHORT_TEXT', 'LONG_TEXT', 'MULTIPLE_CHOICE', 'CHECKBOXES', 'SECTION', 'IMAGE');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('PENDING', 'APPROVED', 'DENIED');--> statement-breakpoint
ALTER TYPE "public"."media_owner" ADD VALUE 'APPLICATION';--> statement-breakpoint
CREATE TABLE "application_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"question_id" uuid,
	"prompt" text DEFAULT '' NOT NULL,
	"type" "application_question" DEFAULT 'SHORT_TEXT' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"choices" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" "application_question" DEFAULT 'SHORT_TEXT' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"max_length" integer,
	"media_id" uuid
);
--> statement-breakpoint
CREATE TABLE "application_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "application_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_note" text DEFAULT '' NOT NULL,
	"cleared_at" timestamp with time zone,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"rank_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4287f5' NOT NULL,
	"open" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone,
	"perma_deny" boolean DEFAULT false NOT NULL,
	"deny_cooldown_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_group_slug_unique" UNIQUE("group_id","slug")
);
--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_submission_id_application_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."application_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_question_id_application_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."application_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_rank_id_rank_relations_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_answers_submission_idx" ON "application_answers" USING btree ("submission_id","order");--> statement-breakpoint
CREATE INDEX "application_questions_order_idx" ON "application_questions" USING btree ("application_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "application_submissions_pending_unique" ON "application_submissions" USING btree ("application_id","user_id") WHERE "application_submissions"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "application_submissions_review_idx" ON "application_submissions" USING btree ("application_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "applications_group_idx" ON "applications" USING btree ("group_id");