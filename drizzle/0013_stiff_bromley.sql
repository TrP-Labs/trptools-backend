ALTER TABLE "users" ADD COLUMN "favorite_routes_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disliked_routes_public" boolean DEFAULT true NOT NULL;