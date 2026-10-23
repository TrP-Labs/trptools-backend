CREATE TABLE "rank_slot_points" (
	"rank_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"points" real DEFAULT 1 NOT NULL,
	CONSTRAINT "rank_slot_points_rank_id_slot_id_pk" PRIMARY KEY("rank_id","slot_id")
);
--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "attendance_min_points" real;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "attendance_max_points" real;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "attendance_required_percent" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "attendance_unsigned_points" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "promotion_rank_id" uuid;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD COLUMN "demotion_rank_id" uuid;--> statement-breakpoint
ALTER TABLE "rank_slot_points" ADD CONSTRAINT "rank_slot_points_rank_id_rank_relations_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_slot_points" ADD CONSTRAINT "rank_slot_points_slot_id_signup_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."signup_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD CONSTRAINT "rank_relations_promotion_rank_id_rank_relations_id_fk" FOREIGN KEY ("promotion_rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_relations" ADD CONSTRAINT "rank_relations_demotion_rank_id_rank_relations_id_fk" FOREIGN KEY ("demotion_rank_id") REFERENCES "public"."rank_relations"("id") ON DELETE set null ON UPDATE no action;