CREATE TABLE "statistics_daily" (
	"group_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "statistics_daily_group_id_day_kind_target_id_pk" PRIMARY KEY("group_id","day","kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "statistics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "statistics_daily" ADD CONSTRAINT "statistics_daily_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statistics_events" ADD CONSTRAINT "statistics_events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statistics_events_pending_idx" ON "statistics_events" USING btree ("received_at") WHERE "statistics_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "statistics_events_retention_idx" ON "statistics_events" USING btree ("received_at");
CREATE INDEX "statistics_events_group_idx" ON "statistics_events" USING btree ("group_id","processed_at");
