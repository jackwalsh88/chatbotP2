import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  audienceMatches,
  HOME_BANNER_SLOTS,
  type BannerViewer,
  type HomeBannerSlot,
} from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  appCategories,
  appCategoryAssets,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  homeHeroClips,
  homePlayWithMeCharacters,
  type CharacterVisualAssetRow,
} from '../db/schema.js';
import { PUBLISHABLE_STATUS, homeRenderableConditions } from './app-merchandising-service.js';
import { PUBLIC_CONTENT_KINDS } from './asset-kinds.js';
import { mediaTypeOf, videoAssetCondition } from './content-review-service.js';
import { renderValue } from './visual-read-service.js';
import {
  characterPostsCondition,
  publicAssetUrl,
  publiclyReachableCondition,
} from './public-media-service.js';
import { listEligibleHomeBanners } from './home-banner-service.js';
import {
  publicBannerCreativeUrl,
  type BannerCreativeStorage,
} from './banner-creative-service.js';

/**
 * Home composition (US-102.4).
 *
 * THE ONE PLACE THAT DECIDES WHAT HOME IS. Every rail, every banner slot and
 * every clip on the public Home surface is assembled here and nowhere else, so
 * "what does the app show" has a single answer that can be read in one file.
 *
 * IT COMPOSES; IT DOES NOT OWN. The pieces already belong to earlier tickets and
 * are consumed through their own functions rather than re-queried:
 *   - US-102.1 owns categories and their identity.
 *   - US-102.2 owns what is in a category and what "publishable" means.
 *   - US-102.3 owns banners, their schedule, their audience and their
 *     eligibility. This file adds only WHERE a banner renders.
 * Nothing here writes to any of them.
 *
 * PUBLISHABILITY IS RE-ASKED ON EVERY READ, never stored. An asset that loses
 * approval leaves Home immediately and returns by itself if approved again; a
 * category unpublished from Home stops rendering without its assignments being
 * touched. There is no cache, no materialised arrangement and no job.
 *
 * THE PUBLIC PROJECTION IS NARROW ON PURPOSE. `listPublishableCategoryAssets`
 * returns the ADMIN row shape — status, contentRating, featured, publishable,
 * and an admin-gated previewUrl. None of that may reach an anonymous browser,
 * so this module builds its own minimal view rather than forwarding one.
 *
 * ONE SYSTEM RAIL, THEN THE OPERATOR'S. Play with Me comes first; published CMS
 * categories follow, in the operator's `position` order — the SAME column the
 * Admin list and the pill strip read, so all four surfaces agree by
 * construction. That ordering is a product decision recorded in the ticket, not
 * an emergent property of the queries.
 *
 * PLAY WITH ME HAS NO MERCHANDISING. It is one deterministic rule — active
 * character, her newest publicly reachable video, one card — with no
 * automatic/curated modes and no operator arrangement. Its override table is
 * retained in the schema and read by nothing.
 *
 * RECENTLY ADDED IS GONE — removed as a product feature, not disabled. It was
 * a rail whose contents no operator could see before publishing and whose
 * "automatic unless overridden" rule made its Admin picker unusable: in the
 * automatic state the rail already contained every candidate, so there was
 * nothing left to add. Nothing here computes it, no route serves it, and no
 * Admin control offers it. The `home_recent_characters` table is deliberately
 * left in place and unreferenced so this removal needs no migration; it holds
 * only operator arrangements for a rail that no longer exists.
 */

/** How many clips a Home category rail carries. Rails are previews, not pages. */
export const CATEGORY_RAIL_LIMIT = 24;

/**
 * How many clips seed the results grid under the search box on first paint.
 *
 * THE GRID ITSELF IS UNCHANGED — same cards, same two columns, same promo tile
 * in third place. What changed is where its first page comes from. The browser
 * used to fill it by calling `/api/browse/clips` with no category and no query
 * the moment Home mounted, against a statement with no LIMIT: every publicly
 * reachable video in the product, downloaded before the visitor had touched the
 * search box.
 *
 * A BOUND IS THE ONLY THING THAT CHANGES. The seed is the same query, the same
 * eligibility and the same newest-first ordering the unfiltered browse returned
 * — its first page rather than all of it. Searching and picking a pill still
 * call `/api/browse/clips`, still unbounded, so no result a visitor asks for is
 * ever truncated.
 *
 * 24 matches CATEGORY_RAIL_LIMIT, the number this file already uses for "a
 * preview, not a page". At the current corpus size the grid is byte-identical
 * to what it showed before.
 */
export const HOME_CLIP_GRID_LIMIT = 24;

/* ------------------------------------------------------------------ *
 * Public projections — deliberately minimal
 * ------------------------------------------------------------------ */

export interface PublicClipView {
  id: string;
  mediaType: 'image' | 'video';
  /** Opaque, id-keyed route. Never a storage key, path or extension. */
  url: string;
  characterId: string;
  characterName: string;
}

export interface PublicCharacterCardView {
  id: string;
  /** Stable slug. The lobby's card components key their local clip manifest on it. */
  name: string;
  displayName: string;
  shortBio: string;
  /**
   * The legacy display locator on `characters` — NOT a storage key. This column
   * has always been an opaque locator chosen by an operator (a URL or a
   * web-served path), never a filesystem path, so exposing it leaks nothing the
   * media route protects. It is the card's last-resort image.
   */
  profileImage: string | null;
  /**
   * The App Categories this character's publicly reachable clips belong to.
   * Real CMS membership — the card chips are editorial, not decoration.
   */
  categories: Array<{ slug: string; name: string }>;
  /** One representative approved clip, or null when the character has none. */
  clip: PublicClipView | null;
}

/**
 * A Play with Me card — HOME'S OWN SHAPE, and deliberately not the one above.
 *
 * WHY IT IS SEPARATE. `PublicCharacterCardView` is the shape
 * `/api/browse/characters` serves, and it carries fields that surface reads
 * (`name`, `shortBio`, `profileImage`). Home's rail renders none of them: the
 * card is a video tile with a display name, an age and up to two category
 * chips. Selecting and shipping three columns that no pixel depends on was pure
 * payload, so Home now has its own projection and the browse endpoint keeps its
 * contract untouched.
 *
 * WHY `apparentAgeBand` IS HERE, AND WHY IT IS ONLY A BAND. Every card shows an
 * age, derived from ONE Visual Identity value. To get it, the browser used to
 * issue `/api/characters/:id/visual-identity` PER CARD — six requests and
 * eighteen queries on a six-card rail — and then throw away everything but that
 * one string: no Visual DNA, no canonical assets, no identity version.
 *
 * The band travels with the card instead. It is the raw operator-entered band
 * ("late 20s"), rendered by the SAME `renderValue` the Character page's About
 * tab uses, and the age arithmetic stays in the browser where it already lived,
 * so the label is computed by unchanged code from an identical input. `null`
 * means the character has no active identity or no band recorded — which is
 * exactly what a failed or empty visual-identity fetch produced before, and it
 * lands on the same client-side default.
 *
 * NOTHING ELSE FROM VISUAL IDENTITY IS HERE, on purpose. Not the DNA, not the
 * canonical gallery, not the identity id or version. Home renders one derived
 * label; anything more would be a second, unowned copy of a projection that
 * `/api/characters/:id/visual-identity` already serves properly to the surface
 * that genuinely needs it.
 */
export interface PublicPlayWithMeCardView {
  id: string;
  displayName: string;
  /** Raw apparent-age band, or null. The card derives its age label from it. */
  apparentAgeBand: string | null;
  /**
   * The App Categories this character's publicly reachable clips belong to.
   * Real CMS membership — the card chips are editorial, not decoration.
   */
  categories: Array<{ slug: string; name: string }>;
  /** One representative approved clip, or null when the character has none. */
  clip: PublicClipView | null;
}

export interface PublicHomeBannerView {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  /** Opaque creative locator, or null when the banner has no creative. */
  creativeUrl: string | null;
  creativeMediaType: 'image' | 'video' | null;
  destination: { kind: string; categoryId: string | null; characterId: string | null; assetId: string | null; url: string | null };
}

export interface PublicCategoryRailView {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  clips: PublicClipView[];
}

export interface PublicHomeView {
  banners: Record<HomeBannerSlot, PublicHomeBannerView[]>;
  hero: PublicClipView[];
  playWithMe: PublicPlayWithMeCardView[];
  categories: PublicCategoryRailView[];
  /**
   * The lobby's category pills, in the operator's CMS order.
   *
   * THE SAME LIST `/api/categories` SERVES, produced by the same rule from the
   * same rows — see `listHomeCategories`. Home used to fetch it in a second
   * request that re-queried `app_categories` for a set this composition had
   * already read, so the pills now ride along and the round trip is gone. The
   * endpoint stays where it is: it is a public, standalone read with its own
   * callers, and nothing here replaces it.
   */
  categoryPills: PublicCategoryPillView[];
  /**
   * The first page of the results grid under the search box.
   *
   * THE SAME CLIPS, IN THE SAME ORDER, that an unfiltered `/api/browse/clips`
   * returned — bounded to HOME_CLIP_GRID_LIMIT. It exists so the grid renders
   * its familiar content on arrival without the browser fetching the entire
   * public corpus to do it. The moment a visitor searches or picks a pill the
   * page goes back to `/api/browse/clips` for the real, unbounded answer.
   */
  browseClips: PublicClipView[];
}

function clipView(
  asset: Pick<CharacterVisualAssetRow, 'id' | 'characterId' | 'storageKey' | 'provenance'>,
  characterName: string,
): PublicClipView | null {
  const url = publicAssetUrl(asset.id, asset.storageKey);
  if (!url) return null;
  return {
    id: asset.id,
    mediaType: mediaTypeOf(asset.storageKey, asset.provenance) === 'video' ? 'video' : 'image',
    url,
    characterId: asset.characterId,
    characterName,
  };
}

/* ------------------------------------------------------------------ *
 * A character's full public content collection
 * ------------------------------------------------------------------ */

/**
 * EVERY publicly reachable content clip belonging to one character.
 *
 * Feeds the Character page's Posts tab, which previously had no data path at
 * all: it read a hard-coded four-name manifest, sliced two entries off it,
 * fabricated six more locked tiles by recycling whatever image it could find,
 * and fell back to `profileImage`. Nothing it showed was a record.
 *
 * NO LIMIT. The collection is the collection — the tab shows what the character
 * has. The old "8" was 2 invented tiles plus 6 invented tiles, never a count.
 *
 * REFERENCE ASSETS ARE EXCLUDED, for the same reason the rails exclude them: a
 * canonical reference is the character's identity image, not a post. This is
 * the one place that could be argued either way, and it is settled the same way
 * everywhere so a "clip" means one thing across the product.
 *
 * SECURITY IS BORROWED, NEVER RESTATED. `publiclyReachableCondition` is the
 * same predicate the media route enforces, so this endpoint cannot list
 * anything whose bytes that route would refuse: unapproved, retired, belonging
 * to an inactive character, or reachable from nowhere. `inArray` on a single id
 * keeps the result the requested character's own — one character can never be
 * handed another's content.
 *
 * `clipView` produces the opaque id-keyed URL, so no storage key or filesystem
 * path can reach the browser.
 *
 * Newest first: this is a feed, and a feed leads with what is new.
 */
export async function listPublicCharacterClips(
  db: Db,
  characterId: string,
): Promise<PublicClipView[]> {
  const rows = await db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        eq(characterVisualAssets.characterId, characterId),
        /**
         * HER COLLECTION, NOT HER HOME PLACEMENTS.
         *
         * This was `publiclyReachableCondition`, which asks whether an operator
         * placed the clip on Home, in a published category or behind a
         * discovery keyword. Posts is her own page, so that gate hid released
         * content of hers that had simply never been merchandised onto Home —
         * a character with five approved, released clips showed one.
         *
         * The replacement is NOT weaker: it demands `published_at`, so an
         * approved-but-unreleased clip is still absent, and it carries the kind
         * allow-list itself — which is why the separate `inArray` here is gone
         * rather than merely moved. One function now answers "may this appear
         * on her page?", so the halves of that answer cannot drift apart.
         *
         * The media route accepts this same condition, so every clip listed
         * here can actually be fetched.
         */
        characterPostsCondition(),
      ),
    )
    .orderBy(desc(characterVisualAssets.createdAt), asc(characterVisualAssets.id));

  return rows
    .map((row) => clipView(row, row.characterName))
    .filter((clip): clip is PublicClipView => clip !== null);
}

/* ------------------------------------------------------------------ *
 * Representative clip for a character card
 * ------------------------------------------------------------------ */

/**
 * One approved VIDEO CLIP to represent a character on a card.
 *
 * A REFERENCE ASSET IS NOT A CLIP. This used to order by `isCanonical` DESC,
 * which made a character's canonical reference — her primary identity image —
 * beat every piece of content she actually has. The card then showed her
 * portrait and the payload called it a clip. Reference assets are now excluded
 * outright: these rails represent a character by her CONTENT, and her identity
 * image is not content.
 *
 * VIDEO ONLY. The character rails are video surfaces; an image asset, even an
 * approved uploaded one, is not what they render. Media type is derived by the
 * shared `mediaTypeOf` (through `clipView`) rather than re-decided here, so the
 * definition of "video" cannot drift from the rest of the system.
 *
 * DETERMINISTIC: NEWEST ELIGIBLE VIDEO FIRST, id as the tie-break. A character
 * with several approved videos always yields the same one, and it is the most
 * recent thing she has published — an operator who uploads a new clip expects
 * to see it, not to wonder why the rail still shows her first ever upload. The
 * id tie-break keeps two clips created in the same transaction from swapping
 * between requests.
 *
 * A character with no eligible video gets NO entry, and her card's clip is
 * null. That null is the whole point — the caller must not turn it back into an
 * image, and `listPlayWithMe` drops the card rather than rendering it blank.
 *
 * Ownership and reachability are unchanged and NOT relaxed: `inArray` keeps
 * every candidate the character's own, and `publiclyReachableCondition` is the
 * same predicate the media route enforces.
 *
 * Fetched for the whole rail in one query rather than per character: N cards
 * must not become N round trips.
 *
 * ONE ROW PER CHARACTER, CHOSEN BY THE DATABASE. This used to select EVERY
 * eligible public asset of every active character and then walk the list in
 * JavaScript, keeping the first video per character and discarding the rest —
 * so a roster with a thousand approved clips shipped a thousand rows across the
 * wire to build six cards. `distinct on (character_id)` with the identical
 * ordering returns exactly the rows that loop kept, and nothing else. The
 * round-trip count is unchanged: still one query, just not one that has to be
 * mostly thrown away.
 *
 * THE SELECTION RULE IS IDENTICAL, arm for arm:
 *   - `videoAssetCondition()` is `mediaTypeOf(...) === 'video'` in SQL, so the
 *     "skip images and keep looking" behaviour of the old loop is now a WHERE
 *     clause rather than a JavaScript `continue`;
 *   - a row with no storage key was dropped by `clipView` returning null and is
 *     now excluded in SQL, which is the same rule (`publicAssetUrl` yields null
 *     for exactly those rows) applied one step earlier;
 *   - the ordering is byte-for-byte the old one, so the row that wins is the
 *     row that won before.
 * `clipView` still produces every projection, so the media type on the returned
 * view is decided by `mediaTypeOf` exactly as it always was.
 */
export async function representativeClips(
  db: Db,
  characterIds: string[],
): Promise<Map<string, PublicClipView>> {
  const found = new Map<string, PublicClipView>();
  if (characterIds.length === 0) return found;

  const rows = await db
    .selectDistinctOn([characterVisualAssets.characterId], {
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      isCanonical: characterVisualAssets.isCanonical,
      characterName: characters.displayName,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        inArray(characterVisualAssets.characterId, characterIds),
        // A reference asset is the character's identity image, not her content.
        // Excluded here rather than de-prioritised, so no ordering change can
        // ever let it back in.
        inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
        // The SAME predicate the media route enforces. Choosing a clip the media
        // route would refuse gives every card a broken image; this makes the two
        // agree by construction rather than by coincidence.
        publiclyReachableCondition(),
        // VIDEO ONLY — the rule the JavaScript loop used to apply after the
        // fact, moved into the query so the database can pick the winner.
        videoAssetCondition(),
        // No storage key means no public locator, which `clipView` expressed by
        // returning null. Such a row could never be the representative clip, so
        // it must not be allowed to win the `distinct on`.
        sql`${characterVisualAssets.storageKey} is not null and ${characterVisualAssets.storageKey} <> ''`,
      ),
    )
    // Newest content first, id as the tie-break — stable between requests. The
    // distinct-on column has to lead the ordering; the two keys that follow are
    // the original ones, so the surviving row per character is unchanged.
    .orderBy(
      asc(characterVisualAssets.characterId),
      desc(characterVisualAssets.createdAt),
      asc(characterVisualAssets.id),
    );

  for (const row of rows) {
    const view = clipView(row, row.characterName);
    // Belt and braces: `mediaTypeOf` is still the authority on what a video is,
    // so a row the SQL translation admitted but this rule would not is dropped
    // here rather than rendered.
    if (view && view.mediaType === 'video') found.set(row.characterId, view);
  }
  return found;
}

async function characterCards(
  db: Db,
  rows: Array<{
    id: string;
    name: string;
    displayName: string;
    shortBio: string;
    profileImage: string | null;
  }>,
): Promise<PublicCharacterCardView[]> {
  const ids = rows.map((row) => row.id);
  const [clips, categories] = await Promise.all([
    representativeClips(db, ids),
    characterCategoryNames(db, ids),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    shortBio: row.shortBio,
    profileImage: row.profileImage,
    categories: categories.get(row.id) ?? [],
    clip: clips.get(row.id) ?? null,
  }));
}

/**
 * Which enabled App Categories each character appears in, via a publicly
 * reachable clip.
 *
 * The card chips in the lobby are these names. They were previously derived in
 * the browser from `index + displayName.length`, which produced stable-looking
 * but entirely invented tags; they are now real editorial membership, so what a
 * visitor reads on a card matches what an operator assigned.
 */
async function characterCategoryNames(
  db: Db,
  characterIds: string[],
): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const found = new Map<string, Array<{ slug: string; name: string }>>();
  if (characterIds.length === 0) return found;

  const rows = await db
    .selectDistinct({
      characterId: characterVisualAssets.characterId,
      slug: appCategories.slug,
      name: appCategories.name,
      position: appCategories.position,
    })
    .from(appCategoryAssets)
    .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .where(
      and(
        inArray(characterVisualAssets.characterId, characterIds),
        eq(appCategories.enabled, true),
        eq(appCategories.homePublished, true),
        publiclyReachableCondition(),
      ),
    )
    .orderBy(asc(appCategories.position), asc(appCategories.slug));

  for (const row of rows) {
    const list = found.get(row.characterId) ?? [];
    list.push({ slug: row.slug, name: row.name });
    found.set(row.characterId, list);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Hero — admin-assigned only
 * ------------------------------------------------------------------ */

/**
 * The Hero carousel: exactly the clips an admin assigned, in their order,
 * filtered to those still approved.
 *
 * No performance input of any kind. This product records no views, plays or
 * impressions, and the ticket states the editorial/performance mixing rule is
 * still unspecified — so inventing a proxy here would be inventing product.
 */
export async function listHeroClips(db: Db): Promise<PublicClipView[]> {
  const rows = await db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
      position: homeHeroClips.position,
    })
    .from(homeHeroClips)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, homeHeroClips.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    // Approved AND owned by an active character: every rail links to a
    // character profile, and a retired character's profile is a 404.
    //
    // The kind allow-list is defence in depth. `addHeroClips` already refuses
    // anything that is not content, so no row here can be private chat media —
    // but the Hero is the most public surface in the product, and it should not
    // depend on a write path having been correct for every row ever inserted.
    .where(
      and(
        eq(characterVisualAssets.status, PUBLISHABLE_STATUS),
        eq(characters.status, 'active'),
        inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
      ),
    )
    .orderBy(asc(homeHeroClips.position), asc(homeHeroClips.assetId));

  return rows
    .map((row) => clipView(row, row.characterName))
    .filter((clip): clip is PublicClipView => clip !== null);
}

/* ------------------------------------------------------------------ *
 * Play with Me — active characters, one card each
 * ------------------------------------------------------------------ */

/**
 * Play with Me. ONE RULE, NO MODES:
 *
 *     active character → newest approved/publicly-reachable VIDEO of hers → one card
 *
 * That sentence is the whole feature. There is no automatic-versus-curated
 * state, no override table, no picker and no merchandising step, because there
 * is nothing left for an operator to arrange: membership is a fact about the
 * content, and the order is alphabetical and stable.
 *
 * WHY THE CURATION WAS DELETED RATHER THAN FIXED. The rail used to be
 * "automatic unless overridden", and in the automatic state it already
 * contained every candidate — so the Add picker had nothing left to offer and
 * an operator could not put a character back. Layering a fix on that model
 * meant keeping two states, a materialise-on-first-edit step and a reset, to
 * arrange a list that the video rule already determines. The override table is
 * retained in the schema but nothing reads or writes it, so this removal needs
 * no migration.
 *
 * ONE CARD = ONE CHARACTER + ONE REAL CMS VIDEO. A character with no publicly
 * reachable video is NOT on this rail — dropped, never rendered as a portrait,
 * a placeholder or an empty frame. That is the point: the rail used to fall
 * back to her canonical identity image, which made an operator believe her
 * content was live when nothing of hers had been published. An honest rail is
 * shorter than a dishonest one.
 *
 * NEVER AN IMAGE. `representativeClips` already restricts the choice to a
 * non-reference VIDEO; the filter here restates that at the rail boundary so a
 * change to card composition cannot quietly admit one.
 *
 * NOT a presence rail. This product has no online/offline state — the ticket
 * defers presence to later work and explicitly says not to fabricate it — so
 * membership is "active AND has a video", which is the only truth the schema
 * holds.
 */
export async function listPlayWithMe(db: Db): Promise<PublicPlayWithMeCardView[]> {
  const eligible = eligibleCards(await playWithMeCards(db, null));

  /**
   * THE OPERATOR'S ORDER, WHERE THERE IS ONE.
   *
   * `home_play_with_me_characters` was defined for exactly this. EMPTY MEANS
   * AUTOMATIC: with no rows the rail is every active character alphabetically,
   * byte for byte what the line above already computed, so an installation
   * that never touches the control cannot observe a change.
   *
   * ORDER IS KEYED ON THE CHARACTER, NOT THE CLIP, and that is the whole
   * reason this is its own table rather than rows in `app_category_assets`.
   * The clip is DERIVED — `representativeClips` runs a `distinct on
   * (character_id)` whose winner changes the moment a newer video is approved
   * or the current one loses approval. An order keyed on the asset would go
   * stale, or duplicate, every time the content behind a card changed. Keyed on
   * the character it simply cannot.
   *
   * MEMBERSHIP STAYS AUTOMATIC. These rows say WHERE a card goes, never
   * WHETHER it appears. A saved character who is not currently eligible is
   * skipped, and an eligible character who was never saved is appended — so
   * the table needs no reaping, no backfill and no add/remove surface.
   *
   * ELIGIBILITY IS NOT NEGOTIABLE, and curating does not become a way around
   * it. A curated character with no publicly reachable video is DROPPED, not
   * rendered as a portrait or an empty frame — the same honesty rule the
   * automatic rail follows, and the reason `eligible` is filtered before this
   * runs rather than after. Ordering decides sequence, never visibility.
   *
   * A curated id that no longer resolves — deleted character, or one that has
   * gone inactive or lost her last video — is simply absent. Nothing repairs
   * the table on read: a row that stops matching is inert, and counts again the
   * moment the character is eligible once more.
   */
  const ordered = await db
    .select({ characterId: homePlayWithMeCharacters.characterId })
    .from(homePlayWithMeCharacters)
    .orderBy(asc(homePlayWithMeCharacters.position), asc(homePlayWithMeCharacters.characterId));
  if (ordered.length === 0) return eligible;

  const byId = new Map(eligible.map((card) => [card.id, card]));
  const placed: PublicPlayWithMeCardView[] = [];
  for (const row of ordered) {
    const card = byId.get(row.characterId);
    if (!card) continue; // saved, but not eligible right now — see above
    placed.push(card);
    byId.delete(row.characterId);
  }
  // Whatever is left is eligible but unplaced: a character who became eligible
  // after the order was saved. She goes AFTER the arranged ones, keeping the
  // alphabetical order she already had. `eligible` is the source, so this
  // preserves it without a second sort.
  return [...placed, ...eligible.filter((card) => byId.has(card.id))];
}

/**
 * THE ELIGIBILITY PREDICATE, as one named function.
 *
 * Play with me, Swipe and Favourites all ask the same question — "does this
 * character have a real published clip to represent her right now?" — and this
 * is the only place that answers it. It used to be an inline `.filter` inside
 * `listPlayWithMe`; naming it is what lets the other two surfaces share the
 * rule by CALLING it rather than by restating it and hoping the restatements
 * stay identical.
 *
 * The clause is unchanged: a card needs a clip, and that clip must be a video.
 * `representativeClips` has already restricted the choice to a non-reference,
 * approved, publicly reachable video owned by that character, so this is the
 * second lock on a decision the SQL already made — not a new rule.
 */
export function isEligibleCard(card: PublicPlayWithMeCardView): boolean {
  return card.clip !== null && card.clip.mediaType === 'video';
}

/** The eligible subset, order preserved. */
export function eligibleCards(
  cards: readonly PublicPlayWithMeCardView[],
): PublicPlayWithMeCardView[] {
  return cards.filter(isEligibleCard);
}

/**
 * Cards for a NAMED set of characters, composed exactly as the rail composes
 * them — same identity join, same clip query, same category membership.
 *
 * THIS IS HOW FAVOURITES STAYS HONEST. A favourite holds a character id and no
 * media locator at all, so the gallery has to ask what that character looks
 * like RIGHT NOW. Because the composition is literally the code path Home runs,
 * a favourite cannot display something Play with me would have refused to show,
 * and replacing a character's published clip changes her Favourites tile on the
 * very next request.
 *
 * CARDS MAY CARRY A NULL CLIP, and the caller decides what that means.
 * `listPlayWithMe` drops them; Favourites keeps the row and renders no tile.
 * Filtering in here would have denied the caller that distinction.
 *
 * INACTIVE CHARACTERS ARE ABSENT, not blank — the `status = 'active'` gate
 * lives in the shared row query, so no caller can opt out of it.
 */
export async function playWithMeCardsFor(
  db: Db,
  characterIds: readonly string[],
): Promise<PublicPlayWithMeCardView[]> {
  if (characterIds.length === 0) return [];
  return playWithMeCards(db, [...characterIds]);
}

/**
 * The row-to-card assembly both callers share.
 *
 * `restrictTo` null means every active character (the rail); a list means those
 * characters and no others (Favourites). The `status = 'active'` condition is
 * NOT parameterised: it is the one gate neither surface may relax.
 */
async function playWithMeCards(
  db: Db,
  restrictTo: string[] | null,
): Promise<PublicPlayWithMeCardView[]> {
  const rows = await db
    .select({
      id: characters.id,
      displayName: characters.displayName,
      /**
       * The ONE Visual Identity value a Home card renders, read here instead of
       * over HTTP.
       *
       * `->` not `->>`, so the driver hands back the stored JSON value with its
       * type intact and `renderValue` sees exactly what the Character page's
       * projection sees. `->>` would flatten a list or an object to raw JSON
       * text and the two surfaces would print different strings.
       *
       * A LEFT JOIN, so a character with no active identity still gets her
       * card — with a null band, which is precisely the state a failed or empty
       * visual-identity fetch produced before. At most one row can join: the
       * schema carries a unique index over (character_id) where status =
       * 'active', so this cannot multiply the roster.
       */
      apparentAgeBand: sql<unknown>`${characterVisualIdentities.visualDna} -> 'apparentAgeBand'`,
    })
    .from(characters)
    .leftJoin(
      characterVisualIdentities,
      and(
        eq(characterVisualIdentities.characterId, characters.id),
        eq(characterVisualIdentities.status, 'active'),
      ),
    )
    .where(
      restrictTo
        ? and(eq(characters.status, 'active'), inArray(characters.id, restrictTo))
        : eq(characters.status, 'active'),
    )
    .orderBy(asc(characters.displayName), asc(characters.id));

  const ids = rows.map((row) => row.id);
  const [clips, categories] = await Promise.all([
    representativeClips(db, ids),
    characterCategoryNames(db, ids),
  ]);

  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    // The SAME renderer the Character page's About tab uses — see renderValue.
    apparentAgeBand: renderValue(row.apparentAgeBand),
    categories: categories.get(row.id) ?? [],
    clip: clips.get(row.id) ?? null,
  }));
}

/* ------------------------------------------------------------------ *
 * Category rails
 * ------------------------------------------------------------------ */

/**
 * The published Home category rails, in the operator's Home order.
 *
 * BOTH GATES. A rail renders only when the category is `enabled` (it exists and
 * is usable) AND `home_published` (an operator deliberately put it on Home).
 * They are independent: a category can be enabled and absent from Home, which
 * is the normal state for most of them.
 *
 * Clip approval is joined in the same query rather than filtered after, so an
 * unapproved asset has no code path to a public rail — the same construction
 * US-102.2 used for its publishable read, for the same reason.
 */
export async function listHomeCategoryRails(db: Db): Promise<PublicCategoryRailView[]> {
  return (await listHomeCategories(db)).rails;
}

/**
 * The rails AND the pills, from ONE read of `app_categories`.
 *
 * WHY THEY ARE PRODUCED TOGETHER. Both are "the categories that are enabled and
 * published to Home" — the same rows, the same gate — differing only in what
 * they carry and in which operator ordering they use (`home_position` for the
 * rails, `position` for the pills). Home used to ask for them in two HTTP
 * requests that each re-queried the table. This function selects those rows
 * once and shapes them twice, so the second round trip disappears without
 * either list changing by a byte: `listPublicCategoryPills` still exists,
 * unchanged, and still serves `/api/categories` for any other caller.
 *
 * THE RAIL LIMIT IS ENFORCED BY THE DATABASE. The clip query used to return
 * every asset ever assigned to every published category and then stop pushing
 * at 24 in JavaScript, so a category holding 500 clips shipped 500 rows to
 * render 24. A `row_number()` window partitioned by category, ordered by the
 * SAME two keys, numbers each category's clips independently and the outer
 * query keeps the first 24 of each — one query still, and never one row more
 * than Home renders. It is deliberately NOT a global `limit`, which would have
 * truncated the whole result set and starved every rail after the first.
 *
 * ROWS WITH NO STORAGE KEY ARE EXCLUDED BEFORE NUMBERING, which is what the old
 * loop did by not counting a null `clipView` toward the 24. Numbering them
 * would have let an unrenderable row consume a slot.
 */
async function listHomeCategories(
  db: Db,
): Promise<{ rails: PublicCategoryRailView[]; pills: PublicCategoryPillView[] }> {
  const cats = await db
    .select()
    .from(appCategories)
    /**
     * THE OPERATOR'S ORDER, AND ONLY IT. Same two keys the Admin list uses
     * (`listAppCategories` orders by position, created_at), so what an operator
     * arranges in Publishing -> Categories is what Home renders. Four surfaces
     * — the Admin list, the pill strip, these rails and the app — now read one
     * column, and cannot disagree.
     *
     * IT USED TO READ `home_position`, AND THAT WAS THE BUG. That column is not
     * an arrangement anyone chooses: `setCategoryHomePublication` assigns it as
     * `max + 1` on publication, so it is publish order. Reordering the list
     * wrote `position` and the rails ignored it — and even once a reorder
     * started syncing the two, merely toggling a category off Home and back on
     * reassigned `home_position` to the end and silently desynchronised them
     * again. Reproduced: position 0,1,2 with home_position 3,1,2, the Admin
     * showing "Top rated, Popular, Newest" and the app showing "Popular,
     * Newest, Top rated".
     *
     * Reading `position` fixes that retroactively, with no write, no backfill
     * and no migration: every installation's existing arrangement becomes
     * correct on the next request.
     */
    .where(and(eq(appCategories.enabled, true), eq(appCategories.homePublished, true)))
    .orderBy(asc(appCategories.position), asc(appCategories.createdAt));

  // The pill strip is the same set in the same order. It stays an explicit
  // in-memory sort rather than relying on the query's, so it remains the
  // comparison `listPublicCategoryPills` expresses in SQL and cannot drift if
  // the rail query is ever re-keyed again.
  const pills: PublicCategoryPillView[] = cats
    .slice()
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((category) => ({ id: category.id, slug: category.slug, name: category.name }));

  if (cats.length === 0) return { rails: [], pills };

  const ranked = db
    .select({
      categoryId: appCategoryAssets.categoryId,
      position: appCategoryAssets.position,
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
      rank: sql<number>`row_number() over (
        partition by ${appCategoryAssets.categoryId}
        order by ${appCategoryAssets.position} asc, ${appCategoryAssets.assetId} asc
      )`.as('rank'),
    })
    .from(appCategoryAssets)
    .innerJoin(characterVisualAssets, eq(characterVisualAssets.id, appCategoryAssets.assetId))
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(
      and(
        inArray(
          appCategoryAssets.categoryId,
          cats.map((c) => c.id),
        ),
        /**
         * THE FOUR RULES, NOW NAMED IN ONE PLACE.
         *
         * They used to be written out here and nowhere else, which is exactly
         * how the Admin came to disagree with this query: approval, content
         * kind, an ACTIVE character (same rule as the Hero — a retired
         * character's clips leave the app with her rather than becoming tiles
         * that link to a 404), and a present storage key, since unrenderable
         * rows must be removed BEFORE numbering or they consume a slot.
         *
         * This rail reads `app_category_assets` directly, so it shows whatever
         * was ever linked — it does not re-ask `publiclyReachableCondition`.
         * The kind gate inside the shared list is what stops a link row
         * pointing at private chat media from rendering it on Home.
         *
         * Behaviour is byte-identical to the four conditions this replaces.
         */
        ...homeRenderableConditions(),
      ),
    )
    .as('ranked');

  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, CATEGORY_RAIL_LIMIT))
    .orderBy(asc(ranked.position), asc(ranked.id));

  const byCategory = new Map<string, PublicClipView[]>();
  for (const row of rows) {
    const list = byCategory.get(row.categoryId) ?? [];
    const view = clipView(row, row.characterName);
    if (view) list.push(view);
    byCategory.set(row.categoryId, list);
  }

  const rails = cats.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    tagline: category.tagline,
    clips: byCategory.get(category.id) ?? [],
  }));
  return { rails, pills };
}

/* ------------------------------------------------------------------ *
 * Banner slots
 * ------------------------------------------------------------------ */

/**
 * Eligible banners, grouped into the two Home slots.
 *
 * ELIGIBILITY IS NOT DECIDED HERE. listEligibleHomeBanners (US-102.3) already
 * applies status, schedule window, dependency health and audience; this only
 * asks where each survivor renders. Re-implementing any part of that filter
 * would create a second, drifting definition of "publicly visible banner".
 *
 * Every slot is always present in the result, possibly empty, so the client
 * renders nothing rather than crashing on a missing key.
 */
export async function listHomeBannerSlots(
  db: Db,
  storage: BannerCreativeStorage,
  options: { now: Date; viewer: BannerViewer },
): Promise<Record<HomeBannerSlot, PublicHomeBannerView[]>> {
  const eligible = await listEligibleHomeBanners(db, storage, options);

  const slots: Record<HomeBannerSlot, PublicHomeBannerView[]> = {
    before_search: [],
    below_results: [],
  };

  for (const banner of eligible) {
    const slot: HomeBannerSlot = HOME_BANNER_SLOTS.includes(banner.slot as HomeBannerSlot)
      ? (banner.slot as HomeBannerSlot)
      : 'before_search';
    slots[slot].push({
      id: banner.id,
      title: banner.title,
      subtitle: banner.subtitle,
      ctaLabel: banner.ctaLabel,
      // The PUBLIC locator, never banner.creative.fileUrl — that one is the
      // admin route and would 401 for every anonymous visitor.
      creativeUrl: banner.creative ? publicBannerCreativeUrl(banner.creative.id) : null,
      creativeMediaType: banner.creative ? banner.creative.mediaType : null,
      destination: {
        kind: banner.destination.kind,
        categoryId: banner.destination.categoryId,
        characterId: banner.destination.characterId,
        assetId: banner.destination.assetId,
        url: banner.destination.url,
      },
    });
  }
  return slots;
}

/* ------------------------------------------------------------------ *
 * The whole surface
 * ------------------------------------------------------------------ */

/**
 * Everything Home needs, in one payload.
 *
 * One `now` for the whole composition, threaded from the route, so a single
 * response can never straddle a schedule boundary and show one banner as live
 * and its neighbour as expired from two different clock reads — the same
 * discipline US-102.3 applies inside its own routes.
 */
export async function composeHome(
  db: Db,
  storage: BannerCreativeStorage,
  options: { now: Date; viewer: BannerViewer },
): Promise<PublicHomeView> {
  const [banners, assignedHero, playWithMe, categories, browseClips] = await Promise.all([
    listHomeBannerSlots(db, storage, options),
    listHeroClips(db),
    listPlayWithMe(db),
    // Rails AND pills from one read — see listHomeCategories. This is why Home
    // no longer needs a second request to `/api/categories`.
    listHomeCategories(db),
    // The results grid's first page — see HOME_CLIP_GRID_LIMIT. This is why
    // Home no longer needs a second request to `/api/browse/clips`, and why it
    // no longer downloads the whole corpus to render a grid.
    browsePublicClips(db, { limit: HOME_CLIP_GRID_LIMIT }),
  ]);
  // AN UNCONFIGURED HERO FALLS BACK; A CONFIGURED ONE NEVER DOES. See
  // heroFallback: assignment is the operator's statement of intent, and once
  // they have made it nothing may add to or override it.
  const hero = assignedHero.length > 0 ? assignedHero : heroFallback(playWithMe);
  return {
    banners,
    hero,
    playWithMe,
    categories: categories.rails,
    categoryPills: categories.pills,
    browseClips,
  };
}

/** How many characters the unconfigured Hero shows. Matches what it always showed. */
export const HERO_FALLBACK_LIMIT = 3;

/**
 * The Hero when an operator has assigned no clips.
 *
 * WHY THERE IS A FALLBACK AT ALL. The Hero is the first thing on Home. Before
 * the CMS existed it always rendered something, and an empty page-top is a
 * worse default than a reasonable one — so an unconfigured Hero borrows the
 * clips Play with Me already resolved rather than going blank.
 *
 * WHY IT IS SAFE. It invents nothing and relaxes nothing. Every clip here came
 * from `representativeClips`, which applies `publiclyReachableCondition` — the
 * same predicate the media route enforces — so the fallback can only ever show
 * a clip that was already public on this page. Characters with no publicly
 * reachable clip contribute nothing, and if none qualify the Hero is empty,
 * exactly as before.
 *
 * WHY IT IS NOT A MERGE. The moment an operator assigns one clip, that list is
 * the Hero, whole. A fallback that topped up a short assigned list would put
 * clips on the front page that nobody chose.
 */
export function heroFallback(
  cards: readonly { clip: PublicClipView | null }[],
): PublicClipView[] {
  const clips: PublicClipView[] = [];
  for (const card of cards) {
    if (clips.length >= HERO_FALLBACK_LIMIT) break;
    if (card.clip) clips.push(card.clip);
  }
  return clips;
}

/** Re-exported so callers do not reach past this module for the audience rule. */
export { audienceMatches };

/* ------------------------------------------------------------------ *
 * The lobby's browse surface: pills and the character grid
 *
 * ONE EDITORIAL SYSTEM. The pills are App Categories — the same categories an
 * operator merchandises, with the same explicit membership and the same
 * operator-chosen order. Discovery categories are NOT exposed here: they remain
 * the keyword index behind free-text search and the landing point for future
 * automatic tagging, so nobody has to understand two category systems to put a
 * clip on the front page.
 *
 * A CATEGORY HOLDS CLIPS; THE LOBBY SHOWS CHARACTERS. Selecting a pill
 * therefore asks "which characters have at least one publicly reachable clip in
 * this category" — computed here, once, rather than guessed in the browser.
 * ------------------------------------------------------------------ */

export interface PublicCategoryPillView {
  id: string;
  slug: string;
  name: string;
}

/**
 * The pills, in the operator's CMS order.
 *
 * PUBLISHED IS THE PUBLIC GATE, and it is one switch. A pill is offered only
 * for a category that is both enabled and published to Home — the same
 * condition that makes its clips publicly reachable at all. Offering a pill for
 * an unpublished category would put a filter on the front page that is
 * guaranteed to return nobody, which reads as a broken app rather than as
 * unpublished configuration.
 *
 * HOME NO LONGER CALLS THIS. The pills ride along in the Home payload, built by
 * `listHomeCategories` from the rows it already reads for the rails — same
 * gate, same ordering, same projection — so opening Home costs one request
 * instead of two. This function is deliberately left in place and unchanged: it
 * is the standalone public read behind `/api/categories`, it has its own tests,
 * and removing a working public endpoint is not part of a performance change.
 */
export async function listPublicCategoryPills(db: Db): Promise<PublicCategoryPillView[]> {
  const rows = await db
    .select({ id: appCategories.id, slug: appCategories.slug, name: appCategories.name })
    .from(appCategories)
    .where(and(eq(appCategories.enabled, true), eq(appCategories.homePublished, true)))
    .orderBy(asc(appCategories.position), asc(appCategories.id));
  return rows;
}

/**
 * The character grid: active characters, newest first, optionally narrowed by a
 * category pill and/or the search box.
 *
 * NO CATEGORY MEANS NO CATEGORY FILTER — the unfiltered "All" state. That is
 * the default and it is why search works before any category exists. An unknown
 * slug is treated the same way rather than returning nothing, so a stale link
 * degrades to browsing instead of to an empty page.
 *
 * The category clause requires a publicly reachable clip in that category, so a
 * pill can never advertise a character whose clips are all unapproved, retired
 * or otherwise not servable. Both filters are independent and combine with AND.
 */
export async function browsePublicCharacters(
  db: Db,
  options: { categorySlug?: string | null; query?: string | null } = {},
): Promise<PublicCharacterCardView[]> {
  const conditions = [eq(characters.status, 'active')];

  const slug = options.categorySlug?.trim();
  if (slug) {
    // Membership is resolved to asset ids FIRST rather than correlated inline.
    // `publiclyReachableCondition` is written against `character_visual_assets`
    // as the outer table, so embedding it in a subquery that joins that same
    // table again would correlate the wrong row — a class of bug that silently
    // returns nothing rather than failing.
    const memberIds = await db
      .select({ characterId: characterVisualAssets.characterId })
      .from(appCategoryAssets)
      .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
      .innerJoin(
        characterVisualAssets,
        eq(characterVisualAssets.id, appCategoryAssets.assetId),
      )
      .where(
        and(
          eq(appCategories.slug, slug),
          eq(appCategories.enabled, true),
          eq(appCategories.homePublished, true),
          publiclyReachableCondition(),
        ),
      );
    const characterIds = [...new Set(memberIds.map((row) => row.characterId))];
    // An empty or unknown category matches NOTHING, never everything — the
    // same rule discovery applies. Silently widening to the whole roster would
    // make a misconfigured pill look like it was working.
    if (characterIds.length === 0) return [];
    conditions.push(inArray(characters.id, characterIds));
  }

  const query = options.query?.trim();
  if (query) {
    // Escaped so a literal % or _ typed by a visitor is matched, not treated as
    // a wildcard. Same rule the discovery search uses.
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(sql`${characters.displayName} ilike ${'%' + escaped + '%'} escape '\\'`);
  }

  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      displayName: characters.displayName,
      shortBio: characters.shortBio,
      profileImage: characters.profileImage,
    })
    .from(characters)
    .where(and(...conditions))
    .orderBy(desc(characters.createdAt), asc(characters.id));

  return characterCards(db, rows);
}

/* ------------------------------------------------------------------ *
 * The lobby's search grid: CONTENT CLIPS, never characters
 * ------------------------------------------------------------------ */

/**
 * Every publicly reachable CONTENT asset, newest first, optionally narrowed by
 * a category pill and/or the search box.
 *
 * WHY THIS EXISTS. The grid under the search box used to be a list of
 * CHARACTERS rendered by a card that resolved its media through
 * `resolveHeroMedia` — so a character with nothing published still appeared,
 * wearing her canonical reference image, and the app presented her identity
 * portrait as though it were content. Search now returns the content itself.
 * A result IS an asset: it has an asset id, it belongs to exactly one
 * character, and its bytes come from the one public media route.
 *
 * A REFERENCE ASSET IS NOT CONTENT, the same rule the character rails apply.
 * Identity images, canonical or otherwise, are excluded by `kind` rather than
 * by ordering, so nothing about how results are sorted can let one back in.
 *
 * BOTH MEDIA TYPES ARE CONTENT. An approved uploaded IMAGE is a legitimate
 * content asset in this model and belongs in results; what is excluded is the
 * identity image, not the medium. `clipView` applies the shared media-type
 * rule so a caller can render each result correctly without re-deciding.
 *
 * THE QUERY MATCHES THE OWNING CHARACTER'S NAME, which is what the search box
 * has always promised ("Search companions by name") and what a visitor typing
 * "Nova" means. The escape keeps a literal % or _ from behaving as a wildcard.
 *
 * NO RESULT IS EVER MANUFACTURED. There is no fallback branch: no
 * `profileImage`, no canonical image, no local manifest, no placeholder. When
 * nothing matches, the answer is an empty array and the caller renders its
 * empty state.
 *
 * Reachability is BORROWED, never restated — `publiclyReachableCondition` is
 * the same predicate the media route enforces, so this grid cannot advertise a
 * clip whose bytes that route would refuse.
 *
 * VIDEO-ONLY AND KEYED IS NOW ASKED IN SQL. Both rules already existed — the
 * `.filter` at the bottom of this function has always dropped a non-video and
 * `clipView` has always returned null for a row with no storage key — but they
 * were applied AFTER the rows had crossed the wire. Moving them into the WHERE
 * changes no result: `videoAssetCondition` is `mediaTypeOf(...) === 'video'`
 * expressed in SQL, and `publicAssetUrl` returns null for exactly the rows the
 * storage-key clause removes. The `.filter` stays where it is, so `mediaTypeOf`
 * remains the authority on what is rendered.
 *
 * It also makes `limit` MEAN something. Applied before those two rules, a limit
 * would count rows that are then discarded and hand back fewer clips than asked
 * for; applied after them, "the newest 24" is exactly 24.
 */
export async function browsePublicClips(
  db: Db,
  options: { categorySlug?: string | null; query?: string | null; limit?: number } = {},
): Promise<PublicClipView[]> {
  const conditions = [
    eq(characters.status, 'active'),
    inArray(characterVisualAssets.kind, [...PUBLIC_CONTENT_KINDS]),
    publiclyReachableCondition(),
    videoAssetCondition(),
    sql`${characterVisualAssets.storageKey} is not null and ${characterVisualAssets.storageKey} <> ''`,
  ];

  const slug = options.categorySlug?.trim();
  if (slug) {
    // Membership resolved to asset ids FIRST, for the same reason
    // `browsePublicCharacters` does it: `publiclyReachableCondition` is written
    // against `character_visual_assets` as the OUTER table, so nesting it in a
    // subquery that joins that table again correlates the wrong row and
    // silently returns nothing.
    const memberIds = await db
      .select({ assetId: appCategoryAssets.assetId })
      .from(appCategoryAssets)
      .innerJoin(appCategories, eq(appCategories.id, appCategoryAssets.categoryId))
      .where(
        and(
          eq(appCategories.slug, slug),
          eq(appCategories.enabled, true),
          eq(appCategories.homePublished, true),
        ),
      );
    const assetIds = [...new Set(memberIds.map((row) => row.assetId))];
    // An empty or unknown category matches NOTHING, never everything — a
    // misconfigured pill must look empty, not look like it was ignored.
    if (assetIds.length === 0) return [];
    conditions.push(inArray(characterVisualAssets.id, assetIds));
  }

  const query = options.query?.trim();
  if (query) {
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(sql`${characters.displayName} ilike ${'%' + escaped + '%'} escape '\\'`);
  }

  const base = db
    .select({
      id: characterVisualAssets.id,
      characterId: characterVisualAssets.characterId,
      storageKey: characterVisualAssets.storageKey,
      provenance: characterVisualAssets.provenance,
      characterName: characters.displayName,
    })
    .from(characterVisualAssets)
    .innerJoin(characters, eq(characters.id, characterVisualAssets.characterId))
    .where(and(...conditions))
    .orderBy(desc(characterVisualAssets.createdAt), asc(characterVisualAssets.id));

  // NO LIMIT UNLESS ONE IS ASKED FOR. `/api/browse/clips` — the search grid —
  // passes none and is unchanged: a visitor who searches still gets every match.
  const rows = await (options.limit != null ? base.limit(options.limit) : base);

  return rows
    .map((row) => clipView(row, row.characterName))
    .filter((clip): clip is PublicClipView => clip !== null && clip.mediaType === 'video');
}
