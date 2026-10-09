CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
