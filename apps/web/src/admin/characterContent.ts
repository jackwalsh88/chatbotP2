import type { CharacterContentAsset } from '../lib/api';

/**
 * A character's content shelf — presentation logic, React-free.
 *
 * WHY THIS EXISTS. Everything here was already reachable, but only from four
 * different screens and none of them the character's own: Review knew her
 * pending items, the Library her approved ones, the merchandising screens her
 * category membership and the Home composer her Hero clips. "What content does
 * Maria have?" had no single answer. This is only the arrangement and wording
 * of the answer the server now assembles.
 *
 * React-free because this repo's web tests run in node with no DOM, and a shelf
 * that silently groups an item into the wrong bucket is exactly the kind of bug
 * a static render cannot catch.
 */

/** The buckets the shelf renders, in the order an operator reads them. */
export interface ContentShelf {
  /** Approved canonical references — the character's primary set. */
  primary: CharacterContentAsset[];
  /** Approved content that is not a primary reference. */
  approved: CharacterContentAsset[];
  /** Awaiting an approve/reject decision in Review. */
  pending: CharacterContentAsset[];
  /** Rejected. Shown rather than hidden, so nothing appears to have vanished. */
  rejected: CharacterContentAsset[];
}

const PENDING_STATUSES = new Set(['generated', 'under_review']);

/**
 * Splits the shelf.
 *
 * The buckets are mutually exclusive and cover every asset — an item cannot be
 * counted twice, and none can fall through and appear nowhere. That total is
 * what makes the section trustworthy as an answer to "is this everything?".
 */
export function groupCharacterContent(
  assets: readonly CharacterContentAsset[],
): ContentShelf {
  const shelf: ContentShelf = { primary: [], approved: [], pending: [], rejected: [] };
  for (const asset of assets) {
    if (asset.status === 'rejected') shelf.rejected.push(asset);
    else if (PENDING_STATUSES.has(asset.status)) shelf.pending.push(asset);
    else if (asset.isPrimary) shelf.primary.push(asset);
    else shelf.approved.push(asset);
  }
  return shelf;
}

/** Operator-facing status wording. Never an upstream term like "generated". */
export function statusLabel(asset: CharacterContentAsset): string {
  switch (asset.status) {
    case 'approved':
      return asset.isPrimary ? 'Primary reference' : 'Approved';
    case 'rejected':
      return 'Rejected';
    default:
      return 'In review';
  }
}

/**
 * Where this item currently appears, in one line.
 *
 * States placement plainly because approved is NOT the same as visible: an
 * approved clip reaches the public app only through the Hero, a published
 * category, or a discovery keyword. An operator who cannot see that difference
 * assumes approval was the last step.
 */
export function placementLabel(asset: CharacterContentAsset): string {
  const parts: string[] = [];
  if (asset.placement.heroPosition !== null) {
    parts.push(`Hero #${asset.placement.heroPosition + 1}`);
  }
  for (const category of asset.placement.categories) {
    parts.push(`${category.name} #${category.position + 1}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  return asset.status === 'approved' ? 'Approved, not placed anywhere yet' : 'Not placed';
}

/** True when this item is approved but reaches no public surface. */
export function isUnplaced(asset: CharacterContentAsset): boolean {
  return (
    asset.status === 'approved' &&
    !asset.isPrimary &&
    asset.placement.heroPosition === null &&
    asset.placement.categories.length === 0
  );
}

/** "12 items · 8 approved · 3 in review · 1 rejected" — the shelf in one line. */
export function shelfSummary(shelf: ContentShelf): string {
  const total =
    shelf.primary.length + shelf.approved.length + shelf.pending.length + shelf.rejected.length;
  if (total === 0) return 'No content yet';
  const parts = [`${total} item${total === 1 ? '' : 's'}`];
  const approved = shelf.primary.length + shelf.approved.length;
  if (approved > 0) parts.push(`${approved} approved`);
  if (shelf.pending.length > 0) parts.push(`${shelf.pending.length} in review`);
  if (shelf.rejected.length > 0) parts.push(`${shelf.rejected.length} rejected`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * What can an operator DO with one item, from here?
 *
 * The shelf could already answer "what content does she have?" but not "and
 * now what?" — approving meant Review, categorising meant the merchandising
 * screen, the Hero meant the Home composer. Every one of those endpoints
 * already existed; only the character's own page could not reach them.
 *
 * These rules decide which controls an item offers. They live here rather than
 * in the tile because the rule is the thing worth testing: offering Approve on
 * something already approved, or "Add to Hero" on something that is not, is a
 * button whose only effect is an error message.
 * ------------------------------------------------------------------ */

export interface AssetActions {
  /** Awaiting a decision: Approve and Reject apply. */
  canApprove: boolean;
  canReject: boolean;
  /** Approved: it may be placed on a public surface. */
  canAddToCategory: boolean;
  canAddToHero: boolean;
  /** Already in the Hero, so adding again would do nothing. */
  inHero: boolean;
  /**
   * Approved CONTENT that is not yet on her Posts tab — the release is
   * available. References and chat media never offer it: one is identity, the
   * other is private, and neither can be a post.
   */
  canPublish: boolean;
  /** Live on her Posts tab, so it can be taken down without un-approving it. */
  canUnpublish: boolean;
}

/**
 * The controls one item offers.
 *
 * Mirrors the SERVER'S rules rather than inventing gentler ones: Review accepts
 * approve/reject only on an undecided item, and both the category picker and
 * the Hero accept approved content only. A rejected item offers nothing here —
 * re-approving is a Review decision, and this page is not a second Review.
 */
export function assetActions(asset: CharacterContentAsset): AssetActions {
  const pending = PENDING_STATUSES.has(asset.status);
  const approved = asset.status === 'approved';
  const inHero = asset.placement.heroPosition !== null;
  // Content only. The server refuses to publish a reference or chat asset, so
  // offering the control for one would promise something it would reject.
  const isContent = asset.kind === 'generated';
  const live = asset.publishedAt !== null;
  return {
    canApprove: pending,
    canReject: pending,
    canAddToCategory: approved,
    canAddToHero: approved && !inHero,
    inHero,
    canPublish: approved && isContent && !live,
    canUnpublish: approved && isContent && live,
  };
}

/**
 * Whether this clip is live on the character's Posts tab.
 *
 * Named rather than inlined because "approved" and "live" are now different
 * questions and the screen has to be able to say which it means.
 */
export function isPublished(asset: CharacterContentAsset): boolean {
  return asset.publishedAt !== null;
}

/** The categories this item is NOT in yet — the only ones worth offering. */
export function categoryChoices(
  asset: CharacterContentAsset,
  categories: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  const already = new Set(asset.placement.categories.map((c) => c.id));
  return categories.filter((category) => !already.has(category.id));
}

/**
 * What approving will and will NOT do, said before the operator commits.
 *
 * The failure this prevents is the common one: approving and assuming the item
 * is now on the app. It is not — approval clears it for use, placement makes it
 * visible, and publishing the character is a third, separate thing.
 */
export function approveConsequence(characterIsLive: boolean): string {
  return characterIsLive
    ? 'Approving clears it for use. It appears on the app only once it is in the Hero or a published category.'
    : 'Approving clears it for use. Nothing of hers is public until she is published.';
}

/* ------------------------------------------------------------------ *
 * Per-clip keywords
 *
 * REUSES THE EXISTING KEYWORD SYSTEM AND ADDS NOTHING TO IT. The server
 * already stores tags in `asset_keywords`, and one endpoint —
 * `PUT /admin/discovery/content/:assetId/keywords` — REPLACES the whole set
 * for one asset. Add, remove and edit are therefore all the same operation on
 * the client: build the next set, send it once, for that asset only.
 *
 * These helpers exist so the draft-set arithmetic is testable. Getting it
 * wrong is silent and destructive — a botched "remove" sends a set that drops
 * keywords the operator never touched.
 * ------------------------------------------------------------------ */

/**
 * Normalises one typed keyword the way the operator means it.
 *
 * Trims and collapses inner whitespace, and lowercases — the server keys
 * keywords canonically, so "Beach" and "beach " must not read as two tags in
 * the editor when they will be one in the database.
 */
export function normaliseKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Accepts one entry, or several separated by commas.
 *
 * Operators paste comma-separated lists; refusing them means retyping. Empty
 * and duplicate entries are dropped rather than rejected, because neither is a
 * mistake worth an error message.
 */
export function addKeywords(current: readonly string[], input: string): string[] {
  const next = [...current];
  for (const part of input.split(',')) {
    const keyword = normaliseKeyword(part);
    if (keyword.length > 0 && !next.includes(keyword)) next.push(keyword);
  }
  return next;
}

/** Removes exactly one keyword. Every other keyword survives untouched. */
export function removeKeyword(current: readonly string[], keyword: string): string[] {
  const target = normaliseKeyword(keyword);
  return current.filter((k) => normaliseKeyword(k) !== target);
}

/**
 * Whether the draft differs from what is saved — order-insensitively.
 *
 * Order carries no meaning in a keyword set, so a reordering is not an unsaved
 * change and must not light up the Save button.
 */
export function keywordsDiffer(saved: readonly string[], draft: readonly string[]): boolean {
  if (saved.length !== draft.length) return true;
  const a = [...saved].map(normaliseKeyword).sort();
  const b = [...draft].map(normaliseKeyword).sort();
  return a.some((keyword, index) => keyword !== b[index]);
}

/* ------------------------------------------------------------------ *
 * Is she live, and if not, what is missing?
 *
 * A name-only character is created INACTIVE on purpose — nothing half-written
 * reaches real users until someone says so, and that rule is not relaxed here.
 * What was missing is the explanation: the operator saw a character that
 * existed, was not public, and gave no indication of why or what to do. State
 * the three facts plainly instead.
 * ------------------------------------------------------------------ */

export interface CharacterReadiness {
  live: boolean;
  /** What is true right now, in one line. */
  headline: string;
  /** The single next action, or null when she is already live. */
  nextStep: string | null;
  /** True while content management is available regardless of being unpublished. */
  contentAllowed: boolean;
}

export function characterReadiness(character: {
  status: string;
  profileComplete: boolean;
}): CharacterReadiness {
  if (character.status === 'active') {
    return {
      live: true,
      headline: 'Live — visitors can find her.',
      nextStep: null,
      contentAllowed: true,
    };
  }
  return {
    live: false,
    headline: 'She exists, but is not published — nobody can see her yet.',
    // The publish button is gated on the profile, so name the gate rather than
    // leaving a disabled control unexplained.
    nextStep: character.profileComplete
      ? 'Press Publish to make her public.'
      : 'Write her profile — or use Autofill — then press Publish.',
    // UPLOADING IS NOT GATED ON PUBLISHING. Content can be built up while she
    // is unpublished, which is the whole point of creating her by name first.
    contentAllowed: true,
  };
}

/* ------------------------------------------------------------------ *
 * Regular and Explicit — the Character page's two content shelves
 * ------------------------------------------------------------------ */

/**
 * The two shelves a character's content is uploaded into.
 *
 * `contentRating` IS the distinction, reusing the column that has always
 * carried it. Regular is `sfw`, Explicit is `explicit`. Nothing new is stored
 * and no migration is involved — the field existed and was simply never
 * surfaced as a place to put things.
 */
export type ContentSection = 'regular' | 'explicit' | 'chat';

/** The shelves the Content area renders, in the order an operator reads them. */
export const CONTENT_SECTIONS: readonly ContentSection[] = ['regular', 'explicit', 'chat'];

/**
 * The rating a section uploads with. One direction, stated once.
 *
 * Chat Content is `sfw` because the chat selector only ever considers sfw
 * assets — sending an explicit clip unprompted in a conversation is a separate
 * product decision nobody has made. The rating axis stays orthogonal to the
 * kind axis, which is why chat is not a rating.
 */
export const SECTION_RATING: Record<ContentSection, 'sfw' | 'explicit'> = {
  regular: 'sfw',
  explicit: 'explicit',
  chat: 'sfw',
};

/** What each shelf will let an operator pick, and what the server enforces. */
export const SECTION_ACCEPTS: Record<ContentSection, 'video' | 'both'> = {
  regular: 'video',
  explicit: 'video',
  chat: 'both',
};

/** The `accept` attribute for each shelf's file input. */
export const SECTION_FILE_ACCEPT: Record<ContentSection, string> = {
  regular: 'video/mp4,video/webm,video/quicktime',
  explicit: 'video/mp4,video/webm,video/quicktime',
  chat: 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime',
};

export interface SectionShelves {
  regular: CharacterContentAsset[];
  explicit: CharacterContentAsset[];
  /** Chat Content — private conversation media. Never a public surface. */
  chat: CharacterContentAsset[];
  /**
   * Everything the three shelves deliberately do not show: identity
   * references, and any image that predates the video-only rule on Regular and
   * Explicit.
   *
   * NAMED AND RETURNED rather than dropped inside the loop, so the split is
   * exhaustive and can be tested as such — every asset lands in exactly one of
   * the four lists. The Character page renders the three shelves; these rows
   * stay in the database, untouched, and are managed from the screens that own
   * them.
   */
  excluded: CharacterContentAsset[];
}

/**
 * Splits a character's assets into the three shelves.
 *
 * KIND DECIDES FIRST, and that ordering is the point. A Chat asset is
 * `kind: 'chat'` whatever its media type or rating, so it lands on the Chat
 * shelf and can never be mistaken for a Regular clip — which is exactly the
 * ambiguity that existed while chat media and Regular content were the same
 * rows on the same columns.
 *
 * REFERENCES ARE NOT CONTENT. A canonical portrait is `kind: 'reference'` and
 * belongs to Visual identity, which has its own section on this page. Left in,
 * it would land under Regular — every reference carries the default `sfw`
 * rating — and read as a clip she had uploaded.
 *
 * IMAGES ARE NOT ON REGULAR OR EXPLICIT. Both are video shelves and the upload
 * path refuses images, but assets uploaded before that rule exist, so they are
 * separated rather than assumed away. Chat Content accepts both, so no such
 * exclusion applies there.
 *
 * Every asset lands in exactly one of the four lists.
 */
export function groupBySection(
  assets: readonly CharacterContentAsset[],
): SectionShelves {
  const shelves: SectionShelves = { regular: [], explicit: [], chat: [], excluded: [] };
  for (const asset of assets) {
    if (asset.kind === 'chat') {
      shelves.chat.push(asset);
    } else if (asset.kind === 'reference' || asset.mediaType !== 'video') {
      shelves.excluded.push(asset);
    } else if (asset.contentRating === 'explicit') {
      shelves.explicit.push(asset);
    } else {
      shelves.regular.push(asset);
    }
  }
  return shelves;
}

/**
 * One shelf's count, said plainly.
 *
 * Regular and Explicit hold videos and say so. Chat Content holds both, so it
 * counts "items" rather than claiming a mix is all video.
 */
export function sectionSummary(
  items: readonly CharacterContentAsset[],
  section: ContentSection = 'regular',
): string {
  const noun = SECTION_ACCEPTS[section] === 'video' ? 'video' : 'item';
  if (items.length === 0) return `No ${noun}s yet.`;
  return `${items.length} ${noun}${items.length === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * Deleting a content item from the Character page
 *
 * THERE IS ONE DELETION PATH AND THIS IS NOT A SECOND ONE. The Character
 * page calls the SAME endpoint the Content Library's Delete calls —
 * `DELETE /admin/content/assets/:assetId`, served by `deleteLibraryAsset`,
 * which removes the row and the file it owns. Nothing here decides what
 * deletion means; it decides what to OFFER, what to WARN, and what to do
 * with the answer. The rules the server enforces are mirrored, never
 * re-implemented.
 * ------------------------------------------------------------------ */

/**
 * Whether the page may offer Delete for this item, and why not when it may not.
 *
 * The one refusal is CANONICAL. `deleteLibraryAsset` answers 409 for a Primary
 * (canonical) asset because canonical membership IS the public gallery, and
 * the reason is mirrored here so the operator reads it before clicking rather
 * than after. This is a mirror of a server rule, not a rule of its own: if the
 * check were somehow wrong, the server still refuses.
 *
 * Everything on the three shelves is otherwise deletable — approved or not,
 * placed or not, image or video. Placement is a warning, never a veto: the
 * schema already resolves it, and inventing a "cannot delete a published clip"
 * rule here would be a new safety semantic nobody asked for.
 */
export function assetDeletable(
  asset: CharacterContentAsset,
): { deletable: true } | { deletable: false; reason: string } {
  if (asset.isPrimary) {
    return {
      deletable: false,
      reason:
        'This is a Primary reference and belongs to the public gallery. Remove it from Primary before deleting.',
    };
  }
  return { deletable: true };
}

/**
 * What the operator is told BEFORE confirming — every consequence that is not
 * visible from the tile.
 *
 * Placement is named rather than summarised because "it is in 2 categories" is
 * not something anyone can act on. The chat clause is separate because the
 * consequence there is different in kind: an already-sent message keeps its
 * text and loses its attachment (`messages.media_asset_id` is ON DELETE SET
 * NULL), which is not something the tile shows and not something a reasonable
 * operator would guess.
 */
export function deletionConsequence(asset: CharacterContentAsset): string {
  const parts = ['This permanently deletes the item and its stored file. It cannot be undone.'];

  const placements: string[] = [];
  if (asset.placement.heroPosition !== null) placements.push('the Home Hero');
  for (const category of asset.placement.categories) placements.push(category.name);
  if (placements.length > 0) {
    parts.push(`It is currently in ${placements.join(', ')} and will be removed from there.`);
  }

  if (asset.kind === 'chat') {
    parts.push(
      'She will no longer be able to send it, and any message that already carried it keeps its text but loses the attachment.',
    );
  }

  return parts.join(' ');
}

/** What the page needs from the outside world to delete one item. */
export interface DeleteAssetDeps {
  /** The canonical Content Library delete — `contentLibraryApi.remove`. */
  remove: (assetId: string) => Promise<unknown>;
  /** Re-reads this character's content from the server. */
  reload: () => Promise<void>;
}

/**
 * The outcome, stated precisely enough to render honestly.
 *
 * `deleted` exists because "the delete failed" and "the delete worked but the
 * page could not refresh" are different facts and must not share a message.
 * Reporting the second as a failure would tell an operator to retry something
 * that already happened.
 */
export type DeleteAssetOutcome =
  | { ok: true }
  | { ok: false; deleted: boolean; message: string };

/**
 * Delete one item, then make the page tell the truth about it.
 *
 * The refresh is a RE-READ, not a local splice. Removing the tile optimistically
 * would show exactly the same thing whether the server had deleted the asset or
 * refused it, which is the "silently pretend it succeeded" failure. Re-reading
 * means the shelf can only lose the item if the server actually lost it.
 *
 * On failure nothing is re-read, so the item stays visible and the operator can
 * see what they still have.
 */
export async function deleteCharacterAsset(
  asset: CharacterContentAsset,
  deps: DeleteAssetDeps,
): Promise<DeleteAssetOutcome> {
  const allowed = assetDeletable(asset);
  if (!allowed.deletable) {
    // Refused before the request: never send one the server will answer 409 to.
    return { ok: false, deleted: false, message: allowed.reason };
  }

  try {
    await deps.remove(asset.assetId);
  } catch (err) {
    return {
      ok: false,
      deleted: false,
      message: err instanceof Error ? err.message : 'Could not delete this item.',
    };
  }

  try {
    await deps.reload();
  } catch {
    return {
      ok: false,
      deleted: true,
      message: 'Deleted, but the page could not refresh. Reload to see the current content.',
    };
  }

  return { ok: true };
}
