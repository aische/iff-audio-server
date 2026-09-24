DROP TABLE IF EXISTS "group_tracks";--> statement-breakpoint
DROP TABLE IF EXISTS "groups";--> statement-breakpoint
CREATE TABLE "arrangements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"clips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrangements_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "arrangements" ADD CONSTRAINT "arrangements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
