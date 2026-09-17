CREATE TABLE "character_personas" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"persona" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_fields" text[] DEFAULT '{}' NOT NULL,
	"source_asset_id" uuid,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_personas" ADD CONSTRAINT "character_personas_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_personas" ADD CONSTRAINT "character_personas_source_asset_id_character_visual_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."character_visual_assets"("id") ON DELETE set null ON UPDATE no action;