import { describe, expect, it } from 'vitest';
import {
  addKeywords,
  approveConsequence,
  assetActions,
  assetDeletable,
  categoryChoices,
  characterReadiness,
  CONTENT_SECTIONS,
  deleteCharacterAsset,
  deletionConsequence,
  groupBySection,
  groupCharacterContent,
  isUnplaced,
  placementLabel,
  sectionSummary,
  SECTION_ACCEPTS,
  SECTION_FILE_ACCEPT,
  SECTION_RATING,
  shelfSummary,
  keywordsDiffer,
  normaliseKeyword,
  removeKeyword,
  statusLabel,
} from './characterContent';
import type { CharacterContentAsset } from '../lib/api';

/**
 * The character content shelf.
 *
 * THE UAT GAP THIS CLOSES. Opening a character showed only her primary
 * references, so manually uploaded content — which can never become one —
 * appeared nowhere on her page. "What content does Maria have?" required
 * visiting Review, the Library, the merchandising screens and the Home
 * composer, and even then nothing said whether an approved clip was actually
 * reachable by anyone.
 */

function asset(over: Partial<CharacterContentAsset> = {}): CharacterContentAsset {
  return {
    assetId: 'a1',
    characterId: 'c1',
    kind: 'generated',
    status: 'approved',
    mediaType: 'video',
    contentRating: 'sfw',
    requirementKey: null,
    // Not released by default: approving no longer publishes, so the fixture
    // must not quietly assume it does.
    publishedAt: null,
    isPrimary: false,
    position: null,
    previewUrl: '/admin/content/assets/a1/file',
    placement: { categories: [], heroPosition: null },
    createdAt: '2026-08-01T00:00:00.000Z',
    approvedAt: '2026-08-02T00:00:00.000Z',
    ...over,
  };
}

describe('the shelf splits content the way an operator reads it', () => {
  it('separates primary references from ordinary approved content', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'p', kind: 'reference', isPrimary: true }),
      asset({ assetId: 'a' }),
    ]);
    expect(shelf.primary.map((x) => x.assetId)).toEqual(['p']);
    expect(shelf.approved.map((x) => x.assetId)).toEqual(['a']);
  });

  it('puts both pending statuses in review, never in approved', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: 'u', status: 'under_review', approvedAt: null }),
      asset({ assetId: 'g', status: 'generated', approvedAt: null }),
    ]);
    expect(shelf.pending.map((x) => x.assetId)).toEqual(['u', 'g']);
    expect(shelf.approved).toEqual([]);
  });

  it('shows rejected content rather than hiding it', () => {
    // Hiding it makes an operator think the file vanished.
    const shelf = groupCharacterContent([asset({ assetId: 'r', status: 'rejected' })]);
    expect(shelf.rejected.map((x) => x.assetId)).toEqual(['r']);
  });

  it('a rejected item that was once primary is rejected, not primary', () => {
    // "Remove from primary" rejects the row, so both flags can be set at once.
    const shelf = groupCharacterContent([
      asset({ assetId: 'x', status: 'rejected', isPrimary: true, kind: 'reference' }),
    ]);
    expect(shelf.rejected.map((x) => x.assetId)).toEqual(['x']);
    expect(shelf.primary).toEqual([]);
  });

  it('every asset lands in exactly one bucket — nothing is lost or double-counted', () => {
    const assets = [
      asset({ assetId: '1', kind: 'reference', isPrimary: true }),
      asset({ assetId: '2' }),
      asset({ assetId: '3', status: 'under_review' }),
      asset({ assetId: '4', status: 'rejected' }),
      asset({ assetId: '5', status: 'generated' }),
    ];
    const shelf = groupCharacterContent(assets);
    const seen = [...shelf.primary, ...shelf.approved, ...shelf.pending, ...shelf.rejected].map(
      (x) => x.assetId,
    );
    expect(seen.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(new Set(seen).size).toBe(assets.length);
  });

  it('an empty shelf is empty, not undefined', () => {
    expect(groupCharacterContent([])).toEqual({
      primary: [],
      approved: [],
      pending: [],
      rejected: [],
    });
  });
});

describe('placement says whether anyone can actually see it', () => {
  it('names the Hero slot, one-based', () => {
    expect(placementLabel(asset({ placement: { categories: [], heroPosition: 0 } }))).toBe(
      'Hero #1',
    );
  });

  it('names every category with the position inside it', () => {
    const placed = asset({
      placement: {
        heroPosition: null,
        categories: [
          { id: 'c', slug: 'sexy', name: 'Sexy', position: 0 },
          { id: 'd', slug: 'new', name: 'New', position: 2 },
        ],
      },
    });
    expect(placementLabel(placed)).toBe('Sexy #1 · New #3');
  });

  it('combines Hero and category membership', () => {
    const placed = asset({
      placement: {
        heroPosition: 1,
        categories: [{ id: 'c', slug: 'sexy', name: 'Sexy', position: 0 }],
      },
    });
    expect(placementLabel(placed)).toBe('Hero #2 · Sexy #1');
  });

  it('says APPROVED BUT NOT PLACED rather than leaving it blank', () => {
    // This is the sentence the UAT was missing: approval is not publication.
    expect(placementLabel(asset())).toBe('Approved, not placed anywhere yet');
  });

  it('does not claim an unapproved item is merely unplaced', () => {
    expect(placementLabel(asset({ status: 'under_review' }))).toBe('Not placed');
  });

  it('flags approved-but-unreachable, and only that', () => {
    expect(isUnplaced(asset())).toBe(true);
    expect(isUnplaced(asset({ status: 'under_review' }))).toBe(false);
    expect(isUnplaced(asset({ kind: 'reference', isPrimary: true }))).toBe(false);
    expect(isUnplaced(asset({ placement: { categories: [], heroPosition: 0 } }))).toBe(false);
    expect(
      isUnplaced(
        asset({
          placement: {
            heroPosition: null,
            categories: [{ id: 'c', slug: 's', name: 'S', position: 0 }],
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('status wording', () => {
  it('never shows an upstream term like "generated"', () => {
    expect(statusLabel(asset({ status: 'generated' }))).toBe('In review');
    expect(statusLabel(asset({ status: 'under_review' }))).toBe('In review');
  });

  it('distinguishes a primary reference from ordinary approved content', () => {
    expect(statusLabel(asset({ kind: 'reference', isPrimary: true }))).toBe('Primary reference');
    expect(statusLabel(asset())).toBe('Approved');
    expect(statusLabel(asset({ status: 'rejected' }))).toBe('Rejected');
  });
});

describe('the one-line summary', () => {
  it('counts every bucket', () => {
    const shelf = groupCharacterContent([
      asset({ assetId: '1', kind: 'reference', isPrimary: true }),
      asset({ assetId: '2' }),
      asset({ assetId: '3', status: 'under_review' }),
      asset({ assetId: '4', status: 'rejected' }),
    ]);
    expect(shelfSummary(shelf)).toBe('4 items · 2 approved · 1 in review · 1 rejected');
  });

  it('omits empty buckets and singularises', () => {
    expect(shelfSummary(groupCharacterContent([asset()]))).toBe('1 item · 1 approved');
  });

  it('says so plainly when there is nothing', () => {
    expect(shelfSummary(groupCharacterContent([]))).toBe('No content yet');
  });
});

describe('a character that is not published says so, and why', () => {
  it('states existence, invisibility and the next step', () => {
    const r = characterReadiness({ status: 'inactive', profileComplete: false });
    expect(r.live).toBe(false);
    expect(r.headline).toContain('exists');
    expect(r.headline).toContain('not published');
    expect(r.nextStep).toContain('profile');
    expect(r.nextStep).toContain('Publish');
  });

  it('names only the remaining step once the profile is written', () => {
    const r = characterReadiness({ status: 'inactive', profileComplete: true });
    expect(r.nextStep).toBe('Press Publish to make her public.');
  });

  it('says nothing is needed once she is live', () => {
    const r = characterReadiness({ status: 'active', profileComplete: true });
    expect(r.live).toBe(true);
    expect(r.nextStep).toBeNull();
  });

  it('NEVER gates content management on publishing', () => {
    // Creating by name and uploading over the following days is the whole
    // point; an unpublished character must still accept content.
    for (const status of ['active', 'inactive']) {
      for (const profileComplete of [true, false]) {
        expect(characterReadiness({ status, profileComplete }).contentAllowed).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Acting on an item from her own page
 *
 * Every endpoint behind these controls already existed; only this page could
 * not reach them. The rule worth pinning is that the buttons offered match
 * what the server will actually accept — a button whose only outcome is an
 * error is worse than no button.
 * ------------------------------------------------------------------ */

describe('the controls an item offers', () => {
  it('offers approve and reject only while a decision is outstanding', () => {
    for (const status of ['generated', 'under_review'] as const) {
      const actions = assetActions(asset({ status }));
      expect(actions.canApprove).toBe(true);
      expect(actions.canReject).toBe(true);
      // Nothing may be placed before it is approved — the server refuses it.
      expect(actions.canAddToCategory).toBe(false);
      expect(actions.canAddToHero).toBe(false);
    }
  });

  it('offers placement only once approved', () => {
    const actions = assetActions(asset({ status: 'approved' }));
    expect(actions.canApprove).toBe(false);
    expect(actions.canReject).toBe(false);
    expect(actions.canAddToCategory).toBe(true);
    expect(actions.canAddToHero).toBe(true);
  });

  it('offers nothing on a rejected item — re-approving is a Review decision', () => {
    expect(assetActions(asset({ status: 'rejected' }))).toEqual({
      canApprove: false,
      canReject: false,
      canAddToCategory: false,
      canAddToHero: false,
      inHero: false,
      // Releasing to Posts is not on offer either: a rejected clip has not
      // passed moderation, and the server refuses to publish one.
      canPublish: false,
      canUnpublish: false,
    });
  });

  it('stops offering the Hero to something already in it', () => {
    const actions = assetActions(asset({ placement: { categories: [], heroPosition: 0 } }));
    expect(actions.inHero).toBe(true);
    expect(actions.canAddToHero).toBe(false);
    // Categories are unaffected: an item can be in the Hero AND a category.
    expect(actions.canAddToCategory).toBe(true);
  });

  it('treats a primary reference as approved content, because it is', () => {
    expect(assetActions(asset({ kind: 'reference', isPrimary: true })).canAddToCategory).toBe(true);
  });
});

describe('the category choices offered for an item', () => {
  const categories = [
    { id: 'c-a', name: 'Trending' },
    { id: 'c-b', name: 'New' },
  ];

  it('offers every category it is not already in', () => {
    expect(categoryChoices(asset(), categories).map((c) => c.id)).toEqual(['c-a', 'c-b']);
  });

  it('drops the ones it is already in, rather than offering a no-op', () => {
    const already = asset({
      placement: {
        categories: [{ id: 'c-a', slug: 'trending', name: 'Trending', position: 0 }],
        heroPosition: null,
      },
    });
    expect(categoryChoices(already, categories).map((c) => c.id)).toEqual(['c-b']);
  });

  it('offers nothing when it is in all of them', () => {
    const all = asset({
      placement: {
        categories: [
          { id: 'c-a', slug: 'trending', name: 'Trending', position: 0 },
          { id: 'c-b', slug: 'new', name: 'New', position: 1 },
        ],
        heroPosition: null,
      },
    });
    expect(categoryChoices(all, categories)).toEqual([]);
  });

  it('survives an empty category list', () => {
    expect(categoryChoices(asset(), [])).toEqual([]);
  });
});

describe('what approving does, said before the operator commits', () => {
  it('separates approval from visibility for a live character', () => {
    const said = approveConsequence(true);
    expect(said).toContain('clears it for use');
    expect(said).toContain('Hero or a published category');
  });

  it('names publication as the gate while she is not live', () => {
    expect(approveConsequence(false)).toContain('until she is published');
  });
});

/* ------------------------------------------------------------------ *
 * Per-clip keywords
 *
 * The endpoint REPLACES an asset's whole keyword set, so add and remove are
 * both "compute the next set correctly". Getting that arithmetic wrong is
 * silent and destructive: a botched remove sends a set missing keywords the
 * operator never touched.
 * ------------------------------------------------------------------ */

describe('normalising a typed keyword', () => {
  it('trims, collapses inner whitespace and lowercases', () => {
    expect(normaliseKeyword('  Beach   Day ')).toBe('beach day');
    expect(normaliseKeyword('BIKINI')).toBe('bikini');
  });

  it('leaves an already-clean keyword alone', () => {
    expect(normaliseKeyword('smiling')).toBe('smiling');
  });
});

describe('adding keywords to one clip', () => {
  it('appends a single keyword', () => {
    expect(addKeywords(['beach'], 'bikini')).toEqual(['beach', 'bikini']);
  });

  it('accepts a comma-separated list, because operators paste them', () => {
    expect(addKeywords([], 'beach, bikini , smiling')).toEqual(['beach', 'bikini', 'smiling']);
  });

  it('never duplicates, whatever the casing or spacing', () => {
    expect(addKeywords(['beach'], 'Beach')).toEqual(['beach']);
    expect(addKeywords(['beach'], '  beach  ')).toEqual(['beach']);
  });

  it('drops empty entries rather than storing blanks', () => {
    expect(addKeywords([], ' , , beach, ')).toEqual(['beach']);
    expect(addKeywords(['beach'], '   ')).toEqual(['beach']);
  });

  it('preserves the existing set, in order', () => {
    expect(addKeywords(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });
});

describe('removing a keyword from one clip', () => {
  it('removes exactly the one named and keeps every other', () => {
    expect(removeKeyword(['beach', 'bikini', 'smiling'], 'bikini')).toEqual(['beach', 'smiling']);
  });

  it('matches regardless of casing or padding', () => {
    expect(removeKeyword(['beach', 'bikini'], ' Bikini ')).toEqual(['beach']);
  });

  it('is a no-op for something not in the set', () => {
    expect(removeKeyword(['beach'], 'sunset')).toEqual(['beach']);
  });

  it('can empty the set — clearing all keywords is a legitimate edit', () => {
    expect(removeKeyword(['beach'], 'beach')).toEqual([]);
  });
});

describe('whether the draft needs saving', () => {
  it('sees an addition and a removal', () => {
    expect(keywordsDiffer(['a'], ['a', 'b'])).toBe(true);
    expect(keywordsDiffer(['a', 'b'], ['a'])).toBe(true);
  });

  it('sees a replacement of the same size', () => {
    expect(keywordsDiffer(['a', 'b'], ['a', 'c'])).toBe(true);
  });

  it('does NOT treat reordering as a change — a keyword set has no order', () => {
    expect(keywordsDiffer(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('treats identical sets as unchanged, including empty ones', () => {
    expect(keywordsDiffer([], [])).toBe(false);
    expect(keywordsDiffer(['a'], ['a'])).toBe(false);
  });

  it('sees clearing everything as a change', () => {
    expect(keywordsDiffer(['a'], [])).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 1 — the Regular / Explicit video shelves.
 *
 * The product question these answer is the one an operator asked: "I uploaded
 * a clip to Maria; where did it go?" Previously it went into a single mixed
 * shelf and then into a review queue. Now the shelf the operator uploaded from
 * decides its rating, and the two shelves are the whole content surface.
 *
 * The rating axis is `content_rating`, which the column has always carried —
 * no new enum, no new column, no migration.
 * ------------------------------------------------------------------ */

describe('Regular and Explicit are split by content rating', () => {
  it('puts an sfw video on Regular and an explicit video on Explicit', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', contentRating: 'sfw' }),
      asset({ assetId: 'x', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['r']);
    expect(shelves.explicit.map((a) => a.assetId)).toEqual(['x']);
  });

  it('never lets a Regular item appear on Explicit, or the reverse', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', contentRating: 'sfw' }),
      asset({ assetId: 'x', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular.some((a) => a.contentRating === 'explicit')).toBe(false);
    expect(shelves.explicit.some((a) => a.contentRating === 'sfw')).toBe(false);
  });

  it('shows items of EVERY status on its shelf, not just approved ones', () => {
    // Uploads land approved now, but anything already in review must still be
    // visible on her page rather than only inside Review.
    const shelves = groupBySection([
      asset({ assetId: 'a', status: 'approved' }),
      asset({ assetId: 'u', status: 'under_review' }),
      asset({ assetId: 'g', status: 'generated' }),
      asset({ assetId: 'j', status: 'rejected' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['a', 'u', 'g', 'j']);
  });

  it('keeps identity references OFF the shelves — they are not content', () => {
    // A reference carries the default `sfw` rating, so without this it would
    // read as a clip she had uploaded to Regular.
    const shelves = groupBySection([asset({ assetId: 'p', kind: 'reference', isPrimary: true })]);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
    expect(shelves.excluded.map((a) => a.assetId)).toEqual(['p']);
  });

  it('keeps images OFF the shelves — both shelves are video-only', () => {
    const shelves = groupBySection([
      asset({ assetId: 'img', mediaType: 'image' }),
      asset({ assetId: 'imgx', mediaType: 'image', contentRating: 'explicit' }),
    ]);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
    expect(shelves.excluded.map((a) => a.assetId)).toEqual(['img', 'imgx']);
  });

  it('accounts for EVERY asset — nothing is silently dropped', () => {
    const input = [
      asset({ assetId: '1' }),
      asset({ assetId: '2', contentRating: 'explicit' }),
      asset({ assetId: '3', mediaType: 'image' }),
      asset({ assetId: '4', kind: 'reference' }),
    ];
    const shelves = groupBySection(input);
    const seen = [...shelves.regular, ...shelves.explicit, ...shelves.excluded];
    expect(seen).toHaveLength(input.length);
    expect(new Set(seen.map((a) => a.assetId)).size).toBe(input.length);
  });

  it('maps each section to exactly one rating, in one direction', () => {
    expect(SECTION_RATING.regular).toBe('sfw');
    expect(SECTION_RATING.explicit).toBe('explicit');
  });
});

describe('the shelf count reads as videos, not items', () => {
  it('says so plainly when a shelf is empty', () => {
    expect(sectionSummary([])).toBe('No videos yet.');
  });

  it('is singular for one and plural beyond that', () => {
    expect(sectionSummary([asset()])).toBe('1 video');
    expect(sectionSummary([asset({ assetId: 'a' }), asset({ assetId: 'b' })])).toBe('2 videos');
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2 — the Chat Content shelf.
 *
 * The bug this prevents is the one the architecture review was written to
 * avoid: an Admin UI that says "Chat Content" while the runtime still pulls
 * from the generic pool. The shelf an operator uploads through has to be
 * recoverable from the STORED asset, not from a label, and `kind` is where it
 * is stored.
 * ------------------------------------------------------------------ */

describe('Chat Content is its own shelf, decided by kind', () => {
  it('puts a chat VIDEO on the Chat shelf, not on Regular', () => {
    const shelves = groupBySection([asset({ assetId: 'c', kind: 'chat', mediaType: 'video' })]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['c']);
    expect(shelves.regular).toEqual([]);
    expect(shelves.explicit).toEqual([]);
  });

  it('puts a chat IMAGE on the Chat shelf rather than hiding it', () => {
    // Regular and Explicit exclude images. Chat accepts them, so an image
    // there must be shown, not swept into `excluded`.
    const shelves = groupBySection([asset({ assetId: 'i', kind: 'chat', mediaType: 'image' })]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['i']);
    expect(shelves.excluded).toEqual([]);
  });

  it('decides by KIND BEFORE rating — a chat asset is never Explicit content', () => {
    // The two axes are orthogonal. Were rating consulted first, a chat asset
    // carrying `explicit` would land on the Explicit shelf and read as
    // merchandisable content.
    const shelves = groupBySection([
      asset({ assetId: 'x', kind: 'chat', contentRating: 'explicit' }),
    ]);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['x']);
    expect(shelves.explicit).toEqual([]);
  });

  it('keeps the three shelves disjoint', () => {
    const shelves = groupBySection([
      asset({ assetId: 'r', kind: 'generated', contentRating: 'sfw' }),
      asset({ assetId: 'e', kind: 'generated', contentRating: 'explicit' }),
      asset({ assetId: 'cv', kind: 'chat', mediaType: 'video' }),
      asset({ assetId: 'ci', kind: 'chat', mediaType: 'image' }),
    ]);
    expect(shelves.regular.map((a) => a.assetId)).toEqual(['r']);
    expect(shelves.explicit.map((a) => a.assetId)).toEqual(['e']);
    expect(shelves.chat.map((a) => a.assetId)).toEqual(['cv', 'ci']);
    expect(shelves.excluded).toEqual([]);
  });

  it('still accounts for EVERY asset across all four lists', () => {
    const input = [
      asset({ assetId: '1' }),
      asset({ assetId: '2', contentRating: 'explicit' }),
      asset({ assetId: '3', kind: 'chat', mediaType: 'image' }),
      asset({ assetId: '4', kind: 'reference' }),
      asset({ assetId: '5', mediaType: 'image' }),
    ];
    const s = groupBySection(input);
    const seen = [...s.regular, ...s.explicit, ...s.chat, ...s.excluded];
    expect(seen).toHaveLength(input.length);
    expect(new Set(seen.map((a) => a.assetId)).size).toBe(input.length);
  });

  it('maps every section to exactly one rating and one accepted media set', () => {
    expect(SECTION_RATING.chat).toBe('sfw');
    expect(SECTION_ACCEPTS.regular).toBe('video');
    expect(SECTION_ACCEPTS.explicit).toBe('video');
    expect(SECTION_ACCEPTS.chat).toBe('both');
  });

  it("offers images in the Chat file picker and nowhere else", () => {
    expect(SECTION_FILE_ACCEPT.chat).toContain('image/');
    expect(SECTION_FILE_ACCEPT.chat).toContain('video/');
    expect(SECTION_FILE_ACCEPT.regular).not.toContain('image/');
    expect(SECTION_FILE_ACCEPT.explicit).not.toContain('image/');
  });

  it('renders exactly three shelves, in order', () => {
    expect(CONTENT_SECTIONS).toEqual(['regular', 'explicit', 'chat']);
  });
});

describe('the shelf count says what the shelf actually holds', () => {
  it('counts videos on the video shelves', () => {
    expect(sectionSummary([], 'regular')).toBe('No videos yet.');
    expect(sectionSummary([asset()], 'explicit')).toBe('1 video');
  });

  it('counts ITEMS on Chat, which holds a mix', () => {
    expect(sectionSummary([], 'chat')).toBe('No items yet.');
    expect(sectionSummary([asset({ assetId: 'a' }), asset({ assetId: 'b' })], 'chat')).toBe(
      '2 items',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Deleting a content item from the Character page
 *
 * The rule this suite exists to hold: the Character page must not GROW a
 * deletion of its own. It offers the Content Library's delete in a second
 * place. So most of what follows is about which call is made, when it is
 * made, and what is claimed afterwards — not about what deletion means.
 * ------------------------------------------------------------------ */

/** Records what the page asked the outside world to do, in order. */
function recorder(behaviour: { remove?: () => Promise<unknown>; reload?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    removed: [] as string[],
    deps: {
      remove: async function (this: void, assetId: string) {
        calls.push(`remove:${assetId}`);
        return behaviour.remove ? behaviour.remove() : undefined;
      },
      reload: async function (this: void) {
        calls.push('reload');
        if (behaviour.reload) await behaviour.reload();
      },
    },
  };
}

describe('the Character page uses the canonical Content Library delete', () => {
  it('calls the injected remove exactly once, with this asset id, then re-reads', async () => {
    // `remove` IS contentLibraryApi.remove at the call site — the same client
    // method the Content Library screen uses, hitting the same route.
    const r = recorder();
    const outcome = await deleteCharacterAsset(asset({ assetId: 'chat-7' }), r.deps);

    expect(outcome).toEqual({ ok: true });
    expect(r.calls).toEqual(['remove:chat-7', 'reload']);
  });

  it('re-reads rather than splicing the item out locally', async () => {
    // Position matters: the reload happens AFTER the delete resolves, so the
    // shelf can only lose the item because the server stopped returning it.
    const r = recorder();
    await deleteCharacterAsset(asset({ assetId: 'x' }), r.deps);
    expect(r.calls.indexOf('reload')).toBeGreaterThan(r.calls.indexOf('remove:x'));
  });

  it('deletes chat, regular and explicit items through the one path', async () => {
    for (const item of [
      asset({ assetId: 'c', kind: 'chat', mediaType: 'image' }),
      asset({ assetId: 'r', kind: 'generated', contentRating: 'sfw' }),
      asset({ assetId: 'e', kind: 'generated', contentRating: 'explicit' }),
    ]) {
      const r = recorder();
      expect(await deleteCharacterAsset(item, r.deps)).toEqual({ ok: true });
      expect(r.calls).toEqual([`remove:${item.assetId}`, 'reload']);
    }
  });
});

describe('a failed delete leaves the item alone and says so', () => {
  it('reports the server message and does NOT refresh the shelf', async () => {
    // Not refreshing is the point: the tile stays visible because the item is
    // still there. A refresh here would redraw the same tile and read as a
    // flicker rather than a failure.
    const r = recorder({
      remove: () => Promise.reject(new Error('Media storage is not configured.')),
    });
    const outcome = await deleteCharacterAsset(asset({ assetId: 'x' }), r.deps);

    expect(outcome).toEqual({
      ok: false,
      deleted: false,
      message: 'Media storage is not configured.',
    });
    expect(r.calls).toEqual(['remove:x']);
    expect(r.calls).not.toContain('reload');
  });

  it('never reports success when the delete threw', async () => {
    const r = recorder({ remove: () => Promise.reject(new Error('boom')) });
    const outcome = await deleteCharacterAsset(asset(), r.deps);
    expect(outcome.ok).toBe(false);
  });

  it('survives a non-Error rejection with a usable message', async () => {
    const r = recorder({ remove: () => Promise.reject('nope') });
    const outcome = await deleteCharacterAsset(asset(), r.deps);
    expect(outcome).toEqual({
      ok: false,
      deleted: false,
      message: 'Could not delete this item.',
    });
  });

  it('distinguishes "did not delete" from "deleted but could not refresh"', async () => {
    // These must not share a message. Telling an operator to retry something
    // that already happened is how an asset gets deleted twice and the second
    // attempt reports a confusing 404.
    const r = recorder({ reload: () => Promise.reject(new Error('network')) });
    const outcome = await deleteCharacterAsset(asset(), r.deps);

    expect(outcome).toMatchObject({ ok: false, deleted: true });
    expect((outcome as { message: string }).message).toContain('Reload');
  });
});

describe('protected assets keep their existing protection', () => {
  it('offers no Delete for a Primary (canonical) reference', () => {
    const primary = assetDeletable(asset({ isPrimary: true }));
    expect(primary.deletable).toBe(false);
    expect((primary as { reason: string }).reason).toContain('Primary');
  });

  it('refuses BEFORE sending a request the server would answer 409 to', async () => {
    const r = recorder();
    const outcome = await deleteCharacterAsset(asset({ isPrimary: true }), r.deps);

    expect(outcome).toMatchObject({ ok: false, deleted: false });
    expect(r.calls).toEqual([]); // nothing was sent, nothing was re-read
  });

  it('does not invent any OTHER refusal', () => {
    // Placement, approval state and media type are the server's business and
    // none of them blocks a delete. A "cannot delete a published clip" rule
    // here would be a new safety semantic nobody asked for.
    expect(assetDeletable(asset({ status: 'under_review' })).deletable).toBe(true);
    expect(assetDeletable(asset({ status: 'rejected' })).deletable).toBe(true);
    expect(assetDeletable(asset({ mediaType: 'image' })).deletable).toBe(true);
    expect(assetDeletable(asset({ kind: 'chat' })).deletable).toBe(true);
    expect(
      assetDeletable(asset({ placement: { categories: [], heroPosition: 0 } })).deletable,
    ).toBe(true);
    expect(
      assetDeletable(
        asset({
          placement: {
            categories: [{ id: 'k1', slug: 'sexy', name: 'Sexy', position: 2 }],
            heroPosition: null,
          },
        }),
      ).deletable,
    ).toBe(true);
  });
});

describe('the confirmation names what the tile cannot show', () => {
  it('always says the file goes and that it cannot be undone', () => {
    const message = deletionConsequence(asset());
    expect(message).toContain('stored file');
    expect(message).toContain('cannot be undone');
  });

  it('names each place the item is published, rather than counting them', () => {
    const message = deletionConsequence(
      asset({
        placement: {
          categories: [
            { id: 'k1', slug: 'sexy', name: 'Sexy', position: 0 },
            { id: 'k2', slug: 'new', name: 'New', position: 1 },
          ],
          heroPosition: 0,
        },
      }),
    );
    expect(message).toContain('Home Hero');
    expect(message).toContain('Sexy');
    expect(message).toContain('New');
    expect(message).toContain('will be removed from there');
  });

  it('says nothing about placement when there is none', () => {
    expect(deletionConsequence(asset())).not.toContain('currently in');
  });

  it('warns that an already-sent chat message keeps its text and loses the media', () => {
    // messages.media_asset_id is ON DELETE SET NULL. Nothing on the tile shows
    // this, and no operator would guess it.
    const message = deletionConsequence(asset({ kind: 'chat' }));
    expect(message).toContain('no longer be able to send it');
    expect(message).toContain('loses the attachment');
  });

  it('does not give the chat warning to a Regular or Explicit clip', () => {
    expect(deletionConsequence(asset({ kind: 'generated' }))).not.toContain('attachment');
  });
});
