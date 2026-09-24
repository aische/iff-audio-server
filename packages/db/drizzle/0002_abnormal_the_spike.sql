DROP TABLE IF EXISTS "track_tags";--> statement-breakpoint
DROP TABLE IF EXISTS "tags";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "comments" SET "updated_at" = "created_at";--> statement-breakpoint
DELETE FROM "comments" AS c
USING "comments" AS newer
WHERE c.user_id = newer.user_id
  AND c.track_id = newer.track_id
  AND (
    c.created_at < newer.created_at
    OR (c.created_at = newer.created_at AND c.id < newer.id)
  );--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_track_unique" UNIQUE("user_id","track_id");
