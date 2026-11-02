CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "track_tags" (
	"track_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_tags_track_id_tag_id_pk" PRIMARY KEY("track_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_tags" ADD CONSTRAINT "track_tags_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_tags" ADD CONSTRAINT "track_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_tags" ADD CONSTRAINT "track_tags_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data: every #token in existing comments becomes a shared tag on that track.
-- Same split as the old client parser: separators are [^A-Za-z0-9#_:-], a tag
-- is a token starting with '#'. Inner '#' characters are dropped.
INSERT INTO "tags" ("name", "created_by", "created_at")
SELECT DISTINCT ON (f.name) f.name, f.user_id, f.created_at
FROM (
	SELECT c.user_id, c.created_at,
		left(regexp_replace(substr(t.tok, 2), '#', '', 'g'), 64) AS name
	FROM "comments" c
	CROSS JOIN LATERAL regexp_split_to_table(c.body, '[^A-Za-z0-9#_:-]+') AS t(tok)
	WHERE t.tok ~ '^#.'
) f
WHERE f.name <> ''
ORDER BY f.name, f.created_at
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
INSERT INTO "track_tags" ("track_id", "tag_id", "added_by", "added_at")
SELECT DISTINCT ON (f.track_id, tg.id) f.track_id, tg.id, f.user_id, f.created_at
FROM (
	SELECT c.track_id, c.user_id, c.created_at,
		left(regexp_replace(substr(t.tok, 2), '#', '', 'g'), 64) AS name
	FROM "comments" c
	CROSS JOIN LATERAL regexp_split_to_table(c.body, '[^A-Za-z0-9#_:-]+') AS t(tok)
	WHERE t.tok ~ '^#.'
) f
JOIN "tags" tg ON tg.name = f.name
ORDER BY f.track_id, tg.id, f.created_at
ON CONFLICT DO NOTHING;
