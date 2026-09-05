import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  assetKeywords,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  discoveryCategories,
  discoveryCategoryKeywords,
  homeHeroClips,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { resolveMediaFile, type ResolvedMediaFile } from './message-media-service.js';
import { PUBLISHABLE_STATUS } from './app-merchandising-service.js';
import { PUBLIC_CONTENT_KINDS, PUBLICLY_REACHABLE_KINDS } from './asset-kinds.js';

/**
 * Public media access (US-102.4).
 *
 * WHY THIS EXISTS AT ALL. Before this ticket the public visual-identity
 * endpoint handed every anonymous browser `row.storageKey` — an absolute
 * filesystem path on the server — as its `imageUrl`. US-102.2 closed exactly
 * this hole for the admin Library and Review surfaces but the public route was
 * never cleaned up. Home cannot render a single clip without a public locator,
 * so the fix lands here rather than being deferred again.
 *
 * THE LOCATOR IS OPAQUE. A client is given `/api/media/assets/:assetId/file`
 * and nothing else. No storage key, no path, no extension, no directory. The
 * id is already public — it is a row identifier the client legitimately holds —
 * and it reveals nothing about where the bytes live.
 *
 * TWO CONDITIONS, BOTH REQUIRED, BOTH IN SQL.
 *
 *  1. APPROVED. `status = 'approved'`, the same single rule US-102.2 defined as
 *     "the one rule that decides whether an asset may be publicly associated".
 *     It is imported from there rather than restated, so there is exactly one
 *     definition of publishable in the codebase.
 *
 *  2. PUBLICLY REACHABLE. Approval alone is not enough. An approved asset that
 *     no public surface references must not be fetchable just because someone
 *     guessed its id — otherwise this route would quietly expose the entire
 *     approved Library, which is an admin surface. An asset is reachable when
 *     it is a canonical reference image of the character's ACTIVE identity
 *     version (already public via the character gallery), a Hero clip, assigned
 *     to a category that is BOTH enabled and published to Home, or carries a
 *     keyword belonging to an ENABLED discovery category.
 *
 *     That last arm is deliberately narrow. "Carries any keyword at all" would
 *     turn an operator's private organisational vocabulary into a publication
 *     switch: tagging a clip `internal-review` would make it fetchable. The
 *     keyword has to be one an enabled discovery category actually queries —
 *     which is exactly the condition under which the strip can reach the clip.
 *     Disabling the last category that uses a keyword closes its content again.
 *
 *  3. ITS CHARACTER IS ACTIVE. Retiring a character already removes them from
 *     every public route — /api/characters and the visual-identity endpoint
 *     both refuse an inactive character. Their media has to go with them, or
 *     retirement would leave the pictures reachable by id after the profile
 *     stopped existing.
 *
 * Both conditions are part of the query, not a filter applied afterwards, so
 * there is no code path through this module that returns an unapproved or
 * unreachable asset. Losing approval, being removed from a category, or the
 * category being unpublished each makes the asset 404 immediately, with no
 * sweep and no cache to invalidate.
 */

export type PublicMediaRefusal = 'not_found' | 'file_missing' | 'not_public';

export interface PublicMediaStorage {
  storageDir: string | null;
  /**
   * MEDIA_OPTIMISED_ENABLED, threaded from env by the route.
   *
   * Absent or false means originals, which is the default everywhere. Nothing
   * about WHICH assets are public depends on this — `publiclyReachableCondition`
   * has already decided that — it chooses only which of two files on disk holds
   * the bytes for an asset the caller is already cleared to fetch.
   */
  preferOptimised?: boolean;
}

/** The opaque locator handed to clients. Never a storage key or path. */
export function publicAssetUrl(assetId: string, storageKey: string | null): string | null {
  return storageKey ? `/api/media/assets/${assetId}/file` : null;
}

/**
 * The one predicate for "this asset is visible to the public right now".
 *
 * Expressed as SQL rather than as a set of ids so it composes into any query
 * and cannot drift from the reads that use it. EXISTS rather than joins so an
 * asset in five published categories still yields one row.
 */
export function publiclyReachableCondition() {
  return and(
    eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
    /**
     * THE KIND GATE, and it is deliberately the FIRST condition.
     *
     * Chat media is authorised per-message per-user by the conversation route
     * and has no business being reachable by id. Without this line the four
     * `or` arms below would each let it out: an operator tagging a chat clip
     * with a keyword that some enabled discovery category happens to query
     * would publish it, silently, with no admin action that looks like
     * publishing.
     *
     * An ALLOW-LIST, not `kind != 'chat'`: the next kind anyone adds is
     * excluded by default rather than admitted by default.
     */
    inArray(characterVisualAssets.kind, [...PUBLICLY_REACHABLE_KINDS]),
    // The owning character must still be active — see condition 3 above.
    sql`exists (
      select 1 from ${characters}
      where ${characters.id} = ${characterVisualAssets.characterId}
        and ${characters.status} = 'active'
    )`,
    or(
      // A canonical reference of the character's ACTIVE identity version — the
      // gallery is version-scoped (visual-read-service passes active.id), so
      // omitting the version here would keep a superseded portrait fetchable
      // long after it stopped being shown anywhere.
      and(
        eq(characterVisualAssets.isCanonical, true),
        eq(characterVisualAssets.kind, 'reference'),
        sql`exists (
          select 1 from ${characterVisualIdentities}
          where ${characterVisualIdentities.id} = ${characterVisualAssets.visualIdentityId}
            and ${characterVisualIdentities.characterId} = ${characterVisualAssets.characterId}
            and ${characterVisualIdentities.status} = 'active'
        )`,
      ),
      // An admin-assigned Hero clip.
      sql`exists (select 1 from ${homeHeroClips} where ${homeHeroClips.assetId} = ${characterVisualAssets.id})`,
      // Merchandised into a category that is enabled AND published to Home.
      sql`exists (
        select 1
        from ${appCategoryAssets}
        join ${appCategories} on ${appCategories.id} = ${appCategoryAssets.categoryId}
        where ${appCategoryAssets.assetId} = ${characterVisualAssets.id}
          and ${appCategories.enabled} = true
          and ${appCategories.homePublished} = true
      )`,
      // Carries a keyword an ENABLED discovery category queries — i.e. the
      // strip can actually reach it. Not merely "has any keyword".
      sql`exists (
        select 1
        from ${assetKeywords}
        join ${discoveryCategoryKeywords}
          on ${discoveryCategoryKeywords.keywordId} = ${assetKeywords.keywordId}
        join ${discoveryCategories}
          on ${discoveryCategories.id} = ${discoveryCategoryKeywords.discoveryCategoryId}
        where ${assetKeywords.assetId} = ${characterVisualAssets.id}
          and ${discoveryCategories.enabled} = true
      )`,
    ),
  );
}

/**
 * Fetches an asset row ONLY when it is currently public. Returns null for
 * unknown, unapproved and unreachable alike — every one of them reads as "not
 * found" so the route leaks no existence information.
 */
/**
 * HER POSTS TAB — a published clip on the character's own page.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
 *
 * `publiclyReachableCondition` above asks a PLACEMENT question: has an operator
 * put this clip on Home, in a published category, or behind a discovery
 * keyword? That is the right question for Home, the search grid and the
 * character rails, which are all placements onto Home.
 *
 * It was the wrong question for the Posts tab, which is not a placement — it is
 * the character's own collection, reached only by someone already looking at
 * her. Gating it on Home placement meant a character with five approved clips
 * showed only the one that happened to be merchandised, and none if none was.
 * Measured against the real query, before this change: 0 of 5 with nothing
 * placed, then 1, 2 and 3 as each clip was individually merchandised, and back
 * to 2 when one category was un-published from Home. Production matched that
 * shape — 30 reachable clips across 29 characters, almost exactly the single
 * clip per character her Play with me card requires.
 *
 * ── APPROVED IS STILL NOT ENOUGH ─────────────────────────────────────────────
 *
 * `published_at is not null` is required, and that is the whole point of the
 * column. Approval remains a MODERATION verdict that exposes nothing, so the
 * standing rule holds unchanged: an approved asset nobody released is a 404
 * here, and no amount of id guessing reaches it.
 *
 * ── WHAT IT CANNOT ADMIT ─────────────────────────────────────────────────────
 *
 * `PUBLIC_CONTENT_KINDS` is `generated` alone, so `chat` — the private
 * per-conversation pool — fails this condition exactly as it fails every other
 * public rule, and a `reference` portrait cannot become a post. Unapproved and
 * unpublished rows fail on their own columns, and an INACTIVE character's
 * content fails the exists-check, so retiring her closes her page immediately.
 *
 * ── IT IS A SEPARATE FUNCTION, NOT A FIFTH ARM ───────────────────────────────
 *
 * Adding an arm to `publiclyReachableCondition` would have changed Play with
 * me, Swipe, Favourites, the search grid and Discovery in one edit — every one
 * of them would have begun counting clips no operator had placed. Those are
 * placements and must keep asking the placement question. Exactly two callers
 * use this instead: the Posts query, and the media route that has to serve what
 * Posts lists.
 */
export function characterPostsCondition() {
  return and(
    eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
    // RELEASED, not merely approved. This is the line that keeps moderation and
    // publication apart.
    sql`${characterVisualAssets.publishedAt} is not null`,
    // Content only: 'chat' and 'reference' are both absent from this list.
    inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
    sql`exists (
      select 1 from ${characters}
      where ${characters.id} = ${characterVisualAssets.characterId}
        and ${characters.status} = 'active'
    )`,
  );
}

export async function getPublicAsset(
  db: Db,
  assetId: string,
): Promise<CharacterVisualAssetRow | null> {
  const [row] = await db
    .select()
    .from(characterVisualAssets)
    /**
     * EITHER route to publication, because this route has to be able to serve
     * whatever a public surface legitimately lists.
     *
     * Posts listing a clip while this route refused its bytes would render
     * every one of those tiles dead — a worse defect than the one being fixed —
     * so the listing rule and the serving rule move together.
     *
     * NEITHER IS RELAXED. `publiclyReachableCondition` is byte-for-byte
     * unchanged, and `characterPostsCondition` demands a release time on top of
     * approval. An approved-but-unreleased asset satisfies neither, so the
     * standing guarantee — approval alone exposes nothing — survives intact.
     */
    .where(
      and(
        eq(characterVisualAssets.id, assetId),
        or(publiclyReachableCondition(), characterPostsCondition()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolves a public asset to streamable bytes.
 *
 * Containment against MEDIA_STORAGE_DIR comes from the shared resolveMediaFile,
 * the same function the chat and admin media routes use — a path outside the
 * storage root is refused even if the column says otherwise.
 */
export function resolvePublicMedia(
  asset: CharacterVisualAssetRow,
  storage: PublicMediaStorage,
): ResolvedMediaFile | { failure: PublicMediaRefusal } {
  if (!storage.storageDir) return { failure: 'not_found' };
  const resolved = resolveMediaFile(asset, storage.storageDir, {
    preferOptimised: storage.preferOptimised === true,
  });
  if ('failure' in resolved) return { failure: 'not_found' };
  return resolved;
}
