ALTER TABLE "character_visual_assets" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- BACKFILL: only what is DEMONSTRABLY PUBLIC ALREADY.
--
-- -- WHY NOT "EVERYTHING APPROVED" ------------------------------------------
--
-- An earlier draft of this backfill published every approved content row, on
-- the reasoning that approving something meant intending it to go live. That
-- reasoning was WRONG, and the codebase says so in three places:
--
--   * generation/config.ts -- "generation NEVER makes content live. Approval is
--     a separate, human act." Generated content lands `under_review`.
--   * public-media-service.ts -- `publiclyReachableCondition` has ALWAYS also
--     required a placement (Hero, published category, or discovery keyword).
--   * the admin shelf renders the literal string "Approved, not placed
--     anywhere yet".
--
-- Approval has never exposed anything. Operators could -- and did -- approve
-- content while it stayed private. Publishing all of it would have released
-- work that was deliberately held back, and the asymmetry matters: a false
-- positive here makes private content public, while a false negative merely
-- leaves a clip needing one click in Admin.
--
-- -- WHY NOT RECONSTRUCT THE SHELF UPLOADS ----------------------------------
--
-- The one population that WAS deliberately released is content uploaded to a
-- character's Regular/Explicit shelf, which approves inside the upload request
-- because "uploading to a character IS the editorial decision". That decision
-- left no trace: `admin-content.ts` reads the shelf name, derives kind and
-- approval from it, and discards it. It is not in provenance, not in a column,
-- not in a join table, and there is no audit log anywhere in this schema. A
-- shelf upload and a Library upload approved later in Review are byte-identical
-- in every persisted field -- same `provenance.source = 'manual-upload'`, same
-- kind, same status, same approvedBy shape.
--
-- The only separator left is TIMING (a shelf upload approves within the request;
-- a Review approval happens whenever someone clicked). That reconstructs intent
-- from latency, it has no floor -- an operator working the queue can approve
-- seconds after uploading -- and it fails in the direction that exposes private
-- content. It is a guess, so this migration does not make it.
--
-- -- WHAT THIS DOES INSTEAD -------------------------------------------------
--
-- Publishes exactly the rows a visitor can ALREADY see. That is an observation
-- of fact, not an inference about intent, so it exposes NOTHING new: Posts
-- renders precisely what it rendered before this migration ran. Its purpose is
-- to stop the new column contradicting reality, so that live content is not
-- silently retired the moment the read path starts consulting it.
--
-- The OR-block below is `publiclyReachableCondition`'s three placement arms,
-- restated in SQL. The fourth arm (a canonical reference of the active
-- identity) is deliberately absent: a portrait is identity, not a post.
--
-- Historical content that was shelf-released but never merchandised onto Home
-- is NOT published here and stays private. It is recovered by an operator in
-- Admin -> Character -> Content, where each item now shows "On her Posts tab" or
-- "Not on her Posts tab" beside a Publish control. That is a human asserting
-- intent for a named character, which is the property this migration cannot
-- have.
--
-- -- SAFETY -----------------------------------------------------------------
--
--   kind = 'generated'      CONTENT only. `chat` is the private per-conversation
--                           pool; `reference` is identity. Neither can be a post.
--   status = 'approved'     nothing unmoderated can be released by this script.
--   published_at IS NULL    idempotent, and can never overwrite a release time
--                           an operator has since set or cleared.
--   storage_key present     a row with no bytes could only ever be a dead tile.
--   character is ACTIVE     content belonging to a removed or inactive character
--                           is never published, so reactivating her cannot
--                           silently restore a back catalogue nobody re-approved.
UPDATE "character_visual_assets" a
SET "published_at" = COALESCE(a."approved_at", a."created_at")
WHERE a."kind" = 'generated'
  AND a."status" = 'approved'
  AND a."published_at" IS NULL
  AND a."storage_key" IS NOT NULL
  AND a."storage_key" <> ''
  AND EXISTS (
    SELECT 1 FROM "characters" c
    WHERE c."id" = a."character_id" AND c."status" = 'active'
  )
  AND (
    EXISTS (
      SELECT 1 FROM "home_hero_clips" h WHERE h."asset_id" = a."id"
    )
    OR EXISTS (
      SELECT 1
      FROM "app_category_assets" ca
      JOIN "app_categories" cat ON cat."id" = ca."category_id"
      WHERE ca."asset_id" = a."id" AND cat."enabled" AND cat."home_published"
    )
    OR EXISTS (
      SELECT 1
      FROM "asset_keywords" ak
      JOIN "discovery_category_keywords" dk ON dk."keyword_id" = ak."keyword_id"
      JOIN "discovery_categories" dc ON dc."id" = dk."discovery_category_id"
      WHERE ak."asset_id" = a."id" AND dc."enabled"
    )
  );
