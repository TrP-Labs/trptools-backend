CREATE TABLE "shift_attendance" (
	"occurrence_id" uuid NOT NULL,
	"roblox_id" text NOT NULL,
	"name" text NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_attendance_occurrence_id_roblox_id_pk" PRIMARY KEY("occurrence_id","roblox_id")
);
--> statement-breakpoint
ALTER TABLE "shift_attendance" ADD CONSTRAINT "shift_attendance_occurrence_id_shift_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."shift_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_attendance_person_idx" ON "shift_attendance" USING btree ("roblox_id");