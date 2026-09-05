import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  homeHeroClips,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import {
  VisualAssetNotFoundError,
  VisualAssetTransitionError,
  type ContentRating,
  type VisualAssetStatus,
} from './visual-asset-service.js';

/**
 * US-106 — read model for the content-review workflow.
 *
 * Deliberately a THIN read layer over the existing tables. It introduces no new
 * lifecycle: approve/reject remain `visual-asset-service`'s job, and the
 * statuses are EPIC 7's (`generated | under_review | approved | rejected`).
 *
 * `listVisualAssets` in visual-asset-service is scoped to one character AND one
 * identity version, which is right for identity work but too narrow for a
 * morning review queue that spans characters. These queries fill that gap
 * without touching that module.
 */

/** Statuses that still need an operator decision. */
export const PENDING_STATUSES = ['generated', 'under_review'] as const satisfies readonly VisualAssetStatus[];

export type MediaType = 'image' | 'video';

/**
 * Media type, resolved in one place. The schema has no media_type column, and
 * inventing one would be a schema change this ticket does not need.
 *
 * Provenance FIRST, extension second. A manual upload's storage_key is a route
 * path ending in `/file` with no extension, so extension sniffing classified
 * every upload as an image — an uploaded video then vanished from the video
 * filter and rendered through the <img> branch. The upload service already
 * records `provenance.mediaType` from the VALIDATED MIME type, which is
 * authoritative; it was simply never read.
 *
 * The extension fallback is unchanged, so generated assets (whose keys do end
 * in .mp4/.png) behave exactly as before, and any row without a recorded
 * mediaType keeps the old behaviour. Existing uploads already carry the
 * provenance field, so they reclassify correctly with no migration or backfill.
 */
export function mediaTypeOf(
  storageKey: string | null,
  provenance?: Record<string, unknown> | null,
): MediaType {
  const recorded = provenance?.mediaType;
  if (recorded === 'video' || recorded === 'image') return recorded;
  return /\.(mp4|webm|mov|m4v)$/i.test(storageKey ?? '') ? 'video' : 'image';
}

/**
 * `mediaTypeOf(...) === 'video'`, expressed in SQL.
 *
 * WHY A SECOND EXPRESSION EXISTS AT ALL. Some reads have to choose ONE row per
 * character — Home's representative clip is the case that forced this — and
 * "one row per character, but only among the videos" cannot be answered
 * set-based unless the database itself can say which rows are videos. The
 * alternative was to fetch every eligible asset of every character and discard
 * almost all of them in JavaScript, which is exactly what this replaces.
 *
 * IT IS A TRANSLATION, NOT A SECOND OPINION. It mirrors `mediaTypeOf` above,
 * arm for arm, and lives directly beneath it so the two are read and edited
 * together:
 *
 *   - provenance FIRST. `->> 'mediaType'` yields NULL when the key is absent or
 *     the value is JSON null, and a recorded value counts only when it is
 *     exactly 'video' or 'image' — the same test the TypeScript makes.
 *   - extension SECOND, and only when provenance said nothing usable.
 *
 * `like '%.mp4'` over a lower-cased key is precisely `/\.(mp4|webm|mov|m4v)$/i`,
 * written without a regex so no escaping hazard can creep in through a tagged
 * template. A NULL storage_key yields NULL, never true, matching the TypeScript
 * fallback of 'image' for a keyless row.
 *
 * `mediaTypeOf` remains the ONE definition every projection uses; this decides
 * only which rows are worth fetching. Every row that reaches JavaScript is
 * still classified by `mediaTypeOf`, so a disagreement could only ever cost a
 * row, never mislabel one. The agreement is pinned by tests.
 */
export function videoAssetCondition() {
  const recorded = sql`${characterVisualAssets.provenance} ->> 'mediaType'`;
  const key = sql`lower(${characterVisualAssets.storageKey})`;
  return sql`(
    ${recorded} = 'video'
    or (
      (${recorded} is null or ${recorded} not in ('video', 'image'))
      and (
        ${key} like '%.mp4'
        or ${key} like '%.webm'
        or ${key} like '%.mov'
        or ${key} like '%.m4v'
      )
    )
  )`;
}

export interface ReviewQueueFilter {
  characterId?: string;
  status?: VisualAssetStatus;
  mediaType?: MediaType;
  limit?: number;
}

export interface ReviewAsset extends CharacterVisualAssetRow {
  characterName: string;
  mediaType: MediaType;
}

/** Newest first — the operator wants what was just produced. */
export async function listReviewQueue(
  db: Db,
  filter: ReviewQueueFilter = {},
): Promise<ReviewAsset[]> {
  const conditions = [eq(characterVisualAssets.kind, 'generated')];
  if (filter.characterId) conditions.push(eq(characterVisualAssets.characterId, filter.characterId));
  if (filter.status) conditions.push(eq(characterVisualAssets.status, filter.status));
  else conditions.push(inArray(characterVisualAssets.status, [...PENDING_STATUSES]));

  const rows = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .orderBy(desc(characterVisualAssets.createdAt))
    .limit(Math.min(filter.limit ?? 100, 200));

  return rows
    .map((r) => ({ ...r.asset, characterName: r.characterName, mediaType: mediaTypeOf(r.asset.storageKey, r.asset.provenance) }))
    .filter((a) => !filter.mediaType || a.mediaType === filter.mediaType);
}

export interface CharacterReviewSummary {
  characterId: string;
  characterName: string;
  pendingCount: number;
}

/** Character-first entry: who has work waiting, and how much. */
export async function summariseReviewByCharacter(db: Db): Promise<CharacterReviewSummary[]> {
  const rows = await db
    .select({
      characterId: characterVisualAssets.characterId,
      characterName: characters.name,
      pendingCount: sql<number>`count(*)::int`,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        eq(characterVisualAssets.kind, 'generated'),
        inArray(characterVisualAssets.status, [...PENDING_STATUSES]),
      ),
    )
    .groupBy(characterVisualAssets.characterId, characters.name)
    .orderBy(desc(sql`count(*)`));
  return rows;
}

export async function getReviewAsset(db: Db, assetId: string): Promise<ReviewAsset | null> {
  const [row] = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(eq(characterVisualAssets.id, assetId));
  if (!row) return null;
  return { ...row.asset, characterName: row.characterName, mediaType: mediaTypeOf(row.asset.storageKey, row.asset.provenance) };
}

/**
 * The ONLY metadata this ticket lets an operator change. Deliberately narrow:
 * everything else on the row is provenance or lifecycle state that review must
 * not rewrite. There is no media editor here and none is implied.
 */
export interface AssetMetadataPatch {
  contentRating?: ContentRating;
  position?: number | null;
  /**
   * Which configured requirement this item satisfies. Filing an item under a
   * category is a review decision — it is how the board gets populated by hand
   * — and `null` un-files it back to triage. The route validates the key
   * against the configured set before it reaches here.
   */
  requirementKey?: string | null;
}

export async function updateAssetMetadata(
  db: Db,
  assetId: string,
  patch: AssetMetadataPatch,
): Promise<CharacterVisualAssetRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.contentRating !== undefined) set.contentRating = patch.contentRating;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.requirementKey !== undefined) set.requirementKey = patch.requirementKey;

  const [updated] = await db
    .update(characterVisualAssets)
    .set(set)
    .where(eq(characterVisualAssets.id, assetId))
    .returning();
  return updated ?? null;
}

/* ------------------------------------------------------------------ *
 * US-100 — Content Library
 * ------------------------------------------------------------------ */

/**
 * The ACTIVE Content Library begins at approval.
 *
 * Content awaiting review is not library content — it belongs to the US-106
 * review queue — and rejected content has left the active workflow entirely.
 * Keeping pre-approval statuses out is what stops an upstream generation term
 * like "Generated" ever surfacing as the status of a library item.
 *
 * An explicit ?status= filter still reaches other states for auditing.
 */
export const LIBRARY_STATUSES = ['approved'] as const satisfies readonly VisualAssetStatus[];

export interface LibraryFilter {
  characterId?: string;
  status?: VisualAssetStatus;
  mediaType?: MediaType;
  /** Free-text match on character name — the only search the model supports cheaply. */
  search?: string;
  limit?: number;
}

/**
 * Why an item is "recent", so the UI can say "Approved 2h ago" rather than
 * conflating it with when the file was produced. approvedAt and createdAt are
 * genuinely different events and the ticket asks for both.
 */
export type RecencyBasis = 'approved' | 'added';

export interface LibraryAsset extends ReviewAsset {
  recencyBasis: RecencyBasis;
  /** The timestamp the recency ordering actually used. */
  recentAt: Date;
}

function toLibraryAsset(asset: ReviewAsset): LibraryAsset {
  // Approval is what puts an item in the library, so approvedAt is its library
  // event. The 'added' basis stays for any future non-approval addition (e.g. a
  // direct upload), which would legitimately be recent by createdAt.
  const approved = asset.status === 'approved' && asset.approvedAt !== null;
  return {
    ...asset,
    recencyBasis: approved ? 'approved' : 'added',
    recentAt: approved ? asset.approvedAt! : asset.createdAt,
  };
}

/** Deterministic ordering: newest recency event first, id as a stable tiebreak. */
export function orderByRecency(assets: readonly LibraryAsset[]): LibraryAsset[] {
  return [...assets].sort((a, b) => {
    const diff = b.recentAt.getTime() - a.recentAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

async function selectLibrary(db: Db, filter: LibraryFilter): Promise<LibraryAsset[]> {
  const conditions = [eq(characterVisualAssets.kind, 'generated')];
  if (filter.characterId) conditions.push(eq(characterVisualAssets.characterId, filter.characterId));
  if (filter.status) {
    // An explicit status filter is honoured even for rejected, so an operator
    // can still audit it — it simply never appears by default.
    conditions.push(eq(characterVisualAssets.status, filter.status));
  } else {
    conditions.push(inArray(characterVisualAssets.status, [...LIBRARY_STATUSES]));
  }

  const rows = await db
    .select({ asset: characterVisualAssets, characterName: characters.name })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .limit(Math.min(filter.limit ?? 200, 500));

  const search = filter.search?.trim().toLowerCase();
  return rows
    .map((r) =>
      toLibraryAsset({
        ...r.asset,
        characterName: r.characterName,
        mediaType: mediaTypeOf(r.asset.storageKey, r.asset.provenance),
      }),
    )
    .filter((a) => !filter.mediaType || a.mediaType === filter.mediaType)
    .filter((a) => !search || a.characterName.toLowerCase().includes(search));
}

/** The full library, newest recency event first. */
export async function listLibrary(db: Db, filter: LibraryFilter = {}): Promise<LibraryAsset[]> {
  return orderByRecency(await selectLibrary(db, filter));
}

/**
 * What changed lately — the first thing the operator sees on entering the
 * library, so newly approved content never has to be searched for.
 */
export async function listRecentLibrary(db: Db, limit = 12): Promise<LibraryAsset[]> {
  return orderByRecency(await selectLibrary(db, {})).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * One character's whole content shelf
 *
 * WHY THIS EXISTS. Everything below was already reachable — the Review board
 * knew a character's pending items, the Library knew its approved ones, the
 * merchandising screens knew its category membership and the Home composer
 * knew its Hero clips — but only from four different screens, none of them the
 * character's own. Opening Maria and asking "what content does she have?" had
 * no answer. This assembles that answer from the existing tables; it adds no
 * lifecycle, no new state and no new permission.
 * ------------------------------------------------------------------ */

/** Where one asset currently appears, editorially. */
export interface AssetPlacement {
  /** App Categories this asset is in, with its operator-chosen position. */
  categories: Array<{ id: string; slug: string; name: string; position: number }>;
  /** Its position in the Hero, or null when it is not assigned there. */
  heroPosition: number | null;
}

export interface CharacterContentAsset {
  assetId: string;
  characterId: string;
  kind: string;
  status: VisualAssetStatus;
  mediaType: MediaType;
  contentRating: ContentRating;
  requirementKey: string | null;
  /** True for an approved canonical reference — the character's primary set. */
  isPrimary: boolean;
  /** Its order within the primary references, when it has one. */
  position: number | null;
  /**
   * Opaque, id-keyed admin locator, or null when the row has no bytes yet.
   * NEVER a storage key or filesystem path — the same rule US-102.2 set for
   * every other admin surface.
   */
  previewUrl: string | null;
  placement: AssetPlacement;
  createdAt: string;
  approvedAt: string | null;
  /**
   * When this asset was RELEASED to the character's public Posts tab, or null.
   *
   * Separate from `approvedAt` on purpose: approving is a moderation verdict
   * and exposes nothing, releasing is what puts a clip on her page. An operator
   * looking at this shelf can now tell "passed review" from "live" — a
   * distinction the screen previously had no way to show.
   */
  publishedAt: string | null;
}

/**
 * Every asset belonging to one character, newest first, whatever its status.
 *
 * Rejected rows are included deliberately: an operator looking at a character
 * needs to see that something was rejected rather than wonder where it went.
 * The caller decides how to group them.
 */
export async function listCharacterContent(
  db: Db,
  characterId: string,
): Promise<CharacterContentAsset[]> {
  const rows = await db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.characterId, characterId))
    .orderBy(desc(characterVisualAssets.createdAt), desc(characterVisualAssets.id));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const [categoryRows, heroRows] = await Promise.all([
    db
      .select({
        assetId: appCategoryAssets.assetId,
        position: appCategoryAssets.position,
        id: appCategories.id,
        slug: appCategories.slug,
        name: appCategories.name,
      })
      .from(appCategoryAssets)
      .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
      .where(inArray(appCategoryAssets.assetId, ids)),
    db
      .select({ assetId: homeHeroClips.assetId, position: homeHeroClips.position })
      .from(homeHeroClips)
      .where(inArray(homeHeroClips.assetId, ids)),
  ]);

  const byAsset = new Map<string, AssetPlacement['categories']>();
  for (const row of categoryRows) {
    const list = byAsset.get(row.assetId) ?? [];
    list.push({ id: row.id, slug: row.slug, name: row.name, position: row.position });
    byAsset.set(row.assetId, list);
  }
  const heroAt = new Map(heroRows.map((row) => [row.assetId, row.position]));

  return rows.map((row) => ({
    assetId: row.id,
    characterId: row.characterId,
    kind: row.kind,
    status: row.status,
    mediaType: mediaTypeOf(row.storageKey, row.provenance),
    contentRating: row.contentRating,
    requirementKey: row.requirementKey,
    isPrimary: row.kind === 'reference' && row.status === 'approved' && row.isCanonical,
    position: row.position,
    // ONE id-keyed admin route for every kind. It resolves both storage
    // conventions itself (a manual upload's real path from provenance, a
    // generated asset's from the key) and refuses anything escaping
    // MEDIA_STORAGE_DIR, so the caller never needs to know which it holds.
    previewUrl: row.storageKey ? `/admin/content/assets/${row.id}/file` : null,
    placement: {
      categories: (byAsset.get(row.id) ?? []).sort((a, b) => a.position - b.position),
      heroPosition: heroAt.get(row.id) ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  }));
}

/* ------------------------------------------------------------------ *
 * Release to the character's Posts tab
 * ------------------------------------------------------------------ */

/**
 * Publish or unpublish one asset — the reversible half of the release model.
 *
 * WHY IT IS SEPARATE FROM APPROVAL. `approveVisualAsset` records a moderation
 * verdict and deliberately exposes nothing. This records the editorial one.
 * Keeping them apart is the entire point of `published_at`: an operator can
 * approve without releasing, and can pull a clip off her page without
 * un-approving it, rejecting it, or deleting anything.
 *
 * PUBLISHING REQUIRES APPROVAL, and refuses rather than silently approving.
 * A release time on unmoderated content would put it live the instant someone
 * approved it, which is exactly the accident this model exists to prevent.
 *
 * CONTENT ONLY. A `reference` portrait is identity and a `chat` asset is
 * private; neither can be a post, so neither can be released. Refusing here as
 * well as at the read gate means an operator gets an error instead of a silent
 * no-op, and the stored data never carries a meaningless release time.
 *
 * IDEMPOTENT: publishing an already-published asset keeps its ORIGINAL release
 * time rather than moving it, so "when did this go out?" stays answerable.
 */
export async function setAssetPublished(
  db: Db,
  assetId: string,
  published: boolean,
): Promise<CharacterVisualAssetRow> {
  const [row] = await db
    .select()
    .from(characterVisualAssets)
    .where(eq(characterVisualAssets.id, assetId))
    .limit(1);
  if (!row) throw new VisualAssetNotFoundError(assetId);

  if (published) {
    if (row.status !== 'approved') {
      throw new VisualAssetTransitionError(
        'Only approved content can be published. Approve it in Review first.',
      );
    }
    if (row.kind !== 'generated') {
      throw new VisualAssetTransitionError(
        'Only character content can be published to Posts. References are identity, and chat media is private.',
      );
    }
    if (row.publishedAt) return row; // already live — keep the original time
  }

  const [updated] = await db
    .update(characterVisualAssets)
    .set({ publishedAt: published ? new Date() : null, updatedAt: new Date() })
    .where(eq(characterVisualAssets.id, assetId))
    .returning();
  return updated!;
}
