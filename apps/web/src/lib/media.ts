import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';

/**
 * The only character fields media resolution actually reads.
 *
 * Narrowed from `PublicCharacter` so the lobby's CMS card payload — which
 * carries identity and locators but not the persona prose — can use the same
 * resolution path. Every existing caller passes a full `PublicCharacter`, which
 * satisfies this structurally, so nothing else changes.
 */
export type MediaCharacter = Pick<
  PublicCharacter,
  'id' | 'name' | 'displayName' | 'profileImage'
> & {
  /**
   * The character's ONE representative publicly-reachable clip, as the server
   * chose it. Optional, because the older `/api/characters` payload has no such
   * field and every existing caller must keep working unchanged.
   *
   * This is the CMS's answer to "what does this character look like right now",
   * and it is the field that lets an operator's uploaded video reach a card.
   * It carries no authority of its own: the server only puts a clip here when
   * `publiclyReachableCondition` passes, so an unapproved clip, a clip placed
   * nowhere, or a clip belonging to an unpublished character simply is not in
   * the payload and cannot be selected here.
   */
  clip?: { url: string; mediaType: 'image' | 'video' } | null;
};
import { API_URL } from './api';

/**
 * Hero-media resolution for the Discover experience (US-19).
 *
 * The discovery card is media-first: it must show a character video when one
 * exists and fall back cleanly to an image otherwise, WITHOUT the card needing
 * a future rewrite when real video arrives. This module is the single, pure,
 * platform-independent place that decides which media a card should render.
 *
 * Data reality (US-19): the existing character API/data model has NO video
 * field — `PublicCharacter` exposes only `profileImage`, and the visual-identity
 * endpoint exposes canonical still images. Video-first is therefore implemented
 * as a forward-compatible SEAM here rather than a backend change. See
 * DEMO_MEDIA_OVERRIDES and `characterVideoUrl` below.
 */

export type HeroMedia =
  | { kind: 'video'; src: string; poster?: string }
  | { kind: 'image'; src: string }
  | { kind: 'placeholder'; initial: string };

/**
 * Clearly-isolated PoC video seam. EMPTY by default — nothing ships enabled.
 *
 * Because the character API has no video field yet, this map is the single
 * place a PoC video asset can be dropped in (keyed by character id) to exercise
 * the video-first path end-to-end without inventing a backend. Production video
 * will instead arrive as a real API field consumed by `characterVideoUrl`, at
 * which point this override map can simply be deleted.
 */
export const DEMO_MEDIA_OVERRIDES: Record<string, { videoUrl?: string; poster?: string }> = {};

/**
 * Defensively reads a possible future `videoUrl` off the character wire shape
 * without prematurely widening the shared `PublicCharacter` type. When the API
 * gains a real video field, this is the only line that needs to change.
 */
function characterVideoUrl(character: MediaCharacter): string | undefined {
  const maybe = (character as { videoUrl?: unknown }).videoUrl;
  return typeof maybe === 'string' && maybe.trim().length > 0 ? maybe : undefined;
}

/**
 * Resolves a media locator to something a browser can actually fetch.
 *
 * US-102.4 replaced the public `imageUrl` with an API-relative opaque route
 * (`/api/media/assets/:id/file`) — it used to be the server's raw storage path.
 * A root-relative path resolves against the WEB origin, which is not where the
 * API lives in any deployed configuration, so it has to be prefixed. Absolute
 * URLs (a PoC override, a future CDN) are passed through untouched.
 */
export function absoluteMediaUrl(raw: string | null | undefined): string | undefined {
  const url = raw?.trim();
  if (!url) return undefined;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return url.startsWith('/') ? `${API_URL}${url}` : url;
}

/** First canonical reference image (by position) from a visual-identity response. */
export function firstCanonicalImage(
  visual: CharacterVisualIdentityResponse | null | undefined,
): string | undefined {
  if (!visual) return undefined;
  const first = visual.canonicalAssets
    .slice()
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    )[0];
  // US-102.4: imageUrl is now an API-relative opaque route
  // (/api/media/assets/:id/file), not an absolute URL. It has to be resolved
  // against the API origin — the web app and the API are separate origins in
  // every deployed configuration.
  const url = absoluteMediaUrl(first?.imageUrl);
  return url && url.length > 0 ? url : undefined;
}

/**
 * The character's CMS clip, when it is a video the browser can be pointed at.
 *
 * This is the seam that connects an operator's upload to a public card. Before
 * it, the only video a card could ever show came from the hard-coded local
 * manifest below, so a character created through the CMS — however many clips
 * were uploaded and approved for her — was permanently a still image.
 *
 * IT RELAXES NOTHING. `clip` is only present when the server's
 * `publiclyReachableCondition` passed: approved, owned by an ACTIVE character,
 * and reachable via the Hero, a published category, a canonical reference or a
 * discovery keyword. An unapproved clip, one placed nowhere, or one belonging
 * to an unpublished character never arrives here to be chosen.
 */
function cmsVideoUrl(character: Partial<MediaCharacter>): string | undefined {
  if (character.clip?.mediaType !== 'video') return undefined;
  // API-relative opaque route — the web app and the API are separate origins.
  return absoluteMediaUrl(character.clip.url);
}

/**
 * Media for the Play with me rail — a real CMS video, or nothing at all.
 *
 * CLIP-ONLY, BY CONSTRUCTION. The rail represents a character by her own
 * content and nothing else. The one and only source here is the server's
 * representative clip, which `representativeClips` has already restricted to a
 * publicly reachable, non-reference VIDEO belonging to that character.
 *
 * WHAT THIS DELIBERATELY CANNOT DO, and why it is a separate function rather
 * than a flag on `resolveHeroMedia`: it cannot reach her canonical image, her
 * `profileImage`, her visual-identity image, or the hard-coded local manifest.
 * The card used to show her portrait when she had no video, which read as "here
 * is her clip" and was not. None of those sources are in scope here, so no
 * future edit to the fallback chain can reintroduce them on a rail.
 *
 * NO ELIGIBLE VIDEO ⇒ NULL, and the caller renders no card.
 *
 * This used to return the neutral initial-letter placeholder, on the reasoning
 * that a curated character should keep her place. That was wrong: a lettered
 * tile among video tiles is still a card claiming she has content, and the rail
 * is now defined as one character plus one real video. The server already drops
 * these characters; returning null means the client cannot put one back even if
 * a future payload carries one. A shorter rail is the honest answer.
 *
 * `resolveHeroMedia` is untouched and still serves the swipe card and the
 * Character page, where showing a character's own image is correct and
 * intended.
 *
 * THE PARAMETER IS FULLY OPTIONAL because `clip` is the only field this reads.
 * Every existing caller passes a whole character and is unaffected; the Home
 * Play with Me card, which deliberately no longer carries `name`, `shortBio` or
 * `profileImage` at all, satisfies it too. Nothing about which media is chosen
 * changes — the body is unchanged.
 */
export function resolveRailMedia(character: Partial<MediaCharacter>): HeroMedia | null {
  const src = cmsVideoUrl(character);
  return src ? { kind: 'video', src } : null;
}

/**
 * Resolves the hero media for a character, video-first:
 *  1. a valid video → video, using the best available still as its poster;
 *  2. otherwise the active Visual Identity's first canonical image, else the
 *     legacy `profileImage` → image;
 *  3. otherwise an initial-letter placeholder (never a broken image).
 *
 * VIDEO PRECEDENCE, and why the CMS sits above the manifest. A PoC override
 * wins first (it exists to force a specific asset during a demo), then a real
 * API `videoUrl` if one ever ships. Then the CMS clip — what an operator
 * actually published — and only then the hard-coded manifest, which is
 * explicitly a stopgap "single, provider-agnostic seam" to be replaced. An
 * operator's published choice must outrank a constant in the source.
 *
 * The seeded characters are unaffected in practice: their representative clip
 * is a canonical IMAGE, so `cmsVideoUrl` returns nothing for them and their
 * manifest clips still play, exactly as before.
 */
export function resolveHeroMedia(
  character: MediaCharacter,
  visual?: CharacterVisualIdentityResponse | null,
): HeroMedia {
  const override = DEMO_MEDIA_OVERRIDES[character.id];
  /**
   * THE BUNDLED MANIFEST IS GONE FROM THIS CHAIN.
   *
   * `characterHeroVideo` used to sit at the end of it, so a character whose
   * stable slug matched one of four PoC names was served a demo file from
   * `/media/<name>/` as though it were hers. That is not published content, and
   * it mis-attributed: a character with slug `ember` and display name "Amber"
   * got Ember's clips. The video sources that remain are an explicit PoC
   * override (empty by default), a future API field, and the CMS's own clip.
   */
  const videoUrl =
    override?.videoUrl ?? characterVideoUrl(character) ?? cmsVideoUrl(character);
  const stillImage = firstCanonicalImage(visual) ?? character.profileImage ?? undefined;

  if (videoUrl) {
    const poster = override?.poster ?? stillImage;
    return poster ? { kind: 'video', src: videoUrl, poster } : { kind: 'video', src: videoUrl };
  }

  if (stillImage) return { kind: 'image', src: stillImage };

  const source = character.displayName || character.name || '?';
  return { kind: 'placeholder', initial: source.charAt(0).toUpperCase() };
}

/** A single item in a character's profile media gallery. */
export interface CharacterMediaItem {
  id: string;
  media: HeroMedia;
  /** Premium-gated: viewing requires the Premium tier (US-19 gate). */
  premium: boolean;
  /** True for clearly-isolated placeholder tiles that have no real asset yet. */
  mock?: boolean;
}

/**
 * The ordered media set for a character's profile gallery (US-19),
 * provider-agnostic:
 *  - item 0 is the free hero (video-first when available);
 *  - any additional REAL canonical stills follow, free and viewable;
 *  - to keep the Premium gate demonstrable in the PoC (seed characters ship a
 *    single canonical asset today), a few clearly-flagged MOCK tiles are
 *    appended and marked premium.
 *
 * When a real media provider (selected in US-17) supplies multiple assets, the
 * mock tiles simply stop being generated — no UI change is needed, which is the
 * whole point of routing every media surface through this one function.
 */
export function characterMediaList(
  character: MediaCharacter,
  visual?: CharacterVisualIdentityResponse | null,
  opts: { minItems?: number } = {},
): CharacterMediaItem[] {
  const minItems = opts.minItems ?? 6;
  const items: CharacterMediaItem[] = [];

  items.push({
    id: `${character.id}:hero`,
    media: resolveHeroMedia(character, visual),
    premium: false,
  });

  const sorted = (visual?.canonicalAssets ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    );
  for (let i = 1; i < sorted.length; i += 1) {
    const url = absoluteMediaUrl(sorted[i]?.imageUrl);
    if (url) items.push({ id: sorted[i]!.id, media: { kind: 'image', src: url }, premium: false });
  }

  const still = firstCanonicalImage(visual) ?? character.profileImage ?? undefined;
  const lockedMedia: HeroMedia = still
    ? { kind: 'image', src: still }
    : { kind: 'placeholder', initial: (character.displayName || character.name || '?').charAt(0).toUpperCase() };
  let n = 0;
  while (items.length < minItems) {
    n += 1;
    items.push({ id: `${character.id}:locked:${n}`, media: lockedMedia, premium: true, mock: true });
  }

  return items;
}

/**
 * One item of a character's public content collection, as
 * `/api/characters/:id/clips` returns it.
 *
 * Structural, not imported from the api module, so this stays a pure module
 * the node-environment tests can exercise without a network shape.
 */
export interface CharacterClipRef {
  id: string;
  /** API-relative opaque locator — never a storage key or a path. */
  url: string;
  mediaType: 'image' | 'video';
}

/**
 * The Character page's HEADER DECK.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
 *
 * The header consulted exactly two sources: the hard-coded four-name manifest
 * (luna, ember, sage, maria), and `character.clip`. But the detail endpoint
 * `/api/characters/:id` returns `PublicCharacter`, and `PublicCharacter` has no
 * `clip` field — that field exists only on the lobby's card payload. So for
 * every character an operator created through the CMS, BOTH sources were empty,
 * `resolveHeroMedia` fell through to the still image, and the header showed her
 * canonical REFERENCE portrait as a static picture however many videos she had
 * published.
 *
 * MEASURED, not assumed: for a CMS character with an approved, publicly
 * reachable video the page computed
 * `{"kind":"image","src":".../api/media/assets/<reference id>/file"}`.
 *
 * ── WHY NO API CHANGE WAS NEEDED ─────────────────────────────────────────────
 *
 * Her videos were already on the page. The Posts tab fetches
 * `/api/characters/:id/clips`, which excludes `kind = 'reference'` in SQL and
 * applies `publiclyReachableCondition` — the same predicate the media route
 * enforces. The header simply never looked at that list. So this takes the data
 * the page already holds; it does not widen a payload, relax a rule, or add a
 * source of visibility.
 *
 * ── PRECEDENCE: THE CMS WINS ─────────────────────────────────────────────────
 *
 * An operator's published video outranks a constant in the source. This used to
 * be the other way round, and the consequence was reported from production:
 * Ember, Maria and Luna each had approved, publicly reachable CMS videos —
 * already powering their Play with me cards and, for two of them, Home Hero
 * slots — while their Character headers still played the bundled demo clips
 * from `characterMedia.ts`. Uploading real content to a seeded character
 * changed nothing an operator could see on her own page.
 *
 * IT ALSO SETTLES A CONTRADICTION. `resolveHeroMedia` has always put the CMS
 * clip ahead of the manifest. Two functions answering the same question in
 * opposite orders is not a policy, it is an accident waiting to be discovered
 * one surface at a time.
 *
 * THE MANIFEST IS NOW A FALLBACK, not a deletion. luna/ember/sage/maria still
 * ship real files on disk, and a seeded character who has no CMS video yet must
 * not lose her header to a still. Removing those files is a separate,
 * deliberate release.
 *
 * VIDEO ONLY. An image clip is not a header clip; the fallback below is the one
 * place a still may appear, and it is the still the design already used.
 *
 * ALWAYS AT LEAST ONE ITEM, so the header can never render an empty deck.
 */
export function characterHeaderItems(
  character: MediaCharacter,
  clips: readonly CharacterClipRef[],
  visual?: CharacterVisualIdentityResponse | null,
): CharacterMediaItem[] {
  // 1. What the operator actually published. `clips` is already reference-free
  //    and approval-gated by the server, so nothing here widens visibility.
  const videos: CharacterMediaItem[] = [];
  for (const clip of clips) {
    if (clip.mediaType !== 'video') continue;
    const src = absoluteMediaUrl(clip.url);
    if (!src) continue;
    videos.push({ id: clip.id, media: { kind: 'video', src }, premium: false });
  }
  if (videos.length > 0) return videos;

  /**
   * 2. Her IDENTITY still: the canonical reference, then `profileImage`, then
   *    an initial-letter tile so the header can never be an empty frame.
   *
   * THE BUNDLED MANIFEST USED TO SIT ABOVE THIS, and it is removed. It served
   * demo files to any character whose slug matched one of four PoC names,
   * outranking her identity image with content that was not hers.
   *
   * WHAT REMAINS IS AN AVATAR, NOT A POST. The header is the one place a
   * character's own portrait is the right thing to show when she has published
   * nothing yet, and it is never presented as content: Posts lists her released
   * clips and nothing else, so a still here can never be mistaken for one.
   */
  return [{ id: 'hero', media: resolveHeroMedia(character, visual), premium: false }];
}

/**
 * The character's apparent-age band, if the public visual identity exposes one
 * (label "Apparent age", e.g. "adult (mid-20s)"). Returns undefined when the
 * data has no age — the card must degrade gracefully rather than invent one.
 */
export function apparentAge(
  visual: CharacterVisualIdentityResponse | null | undefined,
): string | undefined {
  const attr = visual?.identity?.attributes.find(
    (a) => a.label.trim().toLowerCase() === 'apparent age',
  );
  const value = attr?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}
