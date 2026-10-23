CREATE TABLE "attendance_pauses" (
	"group_id" uuid NOT NULL,
	"roblox_id" text NOT NULL,
	"paused_by" uuid,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_pauses_group_id_roblox_id_pk" PRIMARY KEY("group_id","roblox_id")
);
--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "attendance_no_show_points" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_pauses" ADD CONSTRAINT "attendance_pauses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;