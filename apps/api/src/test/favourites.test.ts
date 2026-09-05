import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { characters, characterVisualAssets, favourites } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  testEnv,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * Play with me → Swipe → Favourites.
 *
 * The rules this suite exists to hold:
 *
 *  1. ONE POPULATION. Swipe contains exactly the characters Home's Play with me
 *     rail contains — not a similar set, the same set, in the same order.
 *  2. ELIGIBILITY IS CONTENT. A character with no publicly reachable VIDEO is
 *     in neither surface. Not as a portrait, not as a placeholder, not at all.
 *  3. NO FALLBACK MEDIA CAN REACH THESE SURFACES. Every clip served is a real
 *     approved content asset behind the opaque media route; no storage path, no
 *     profileImage and no reference image appears in any payload.
 *  4. A RIGHT SWIPE SAVES AND NEVER UNSAVES. Repeating it leaves her saved.
 *  5. ONLY THE HEART REMOVES, and what the heart shows is what is persisted.
 *  6. A FAVOURITE IS A CHARACTER, NOT A CLIP. It stores no media, so it follows
 *     an operator's replacement automatically and shows nothing when there is
 *     nothing current to show.
 *  7. FAVOURITES ARE PRIVATE AND AUTHENTICATED. They survive a new session and
 *     are invisible to every other account.
 *  8. UNRELATED SURFACES ARE UNCHANGED.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
const MARIA = SEED_CHARACTERS.find((c) => c.name === 'maria')!;
/** Seeded INACTIVE, deliberately — a ready-made retired character. */
const SAGE = SEED_CHARACTERS.find((c) => c.name === 'sage')!;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** EBML magic + filler. The server classifies by extension; only the key matters. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0x42)]);

let on: TestContext;
let adminCookies: Record<string, string>;
let userCookies: Record<string, string>;
let seq = 0;

beforeAll(async () => {
  migrateTestDb();
  on = await createTestContext();
});
afterAll(async () => destroyTestContext(on));

beforeEach(async () => {
  await truncateAll(on);
  await seedCharacters(on.db);
  await seedVisualIdentities(on.db);
  adminCookies = await register('fav.admin@example.com', 'admin');
  userCookies = await register('fav.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'favourites-test-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

/** A second signed-in session for the SAME account — what a refresh looks like. */
async function signIn(email: string) {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'favourites-test-1' },
  });
  const cookie = extractSessionCookie(res)!;
  return { [cookie.name]: cookie.value };
}

async function makeAsset(
  characterId: string,
  opts: { video: boolean; approved?: boolean; kind?: 'generated' | 'reference' },
) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: opts.kind ?? 'generated',
    status: opts.approved === false ? 'under_review' : 'approved',
    contentRating: 'sfw',
  });
  const path = join(
    testEnv.media.storageDir,
    'favourites-test',
    `${asset.id}.${opts.video ? 'webm' : 'png'}`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, opts.video ? WEBM : PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

/** Makes an asset PUBLICLY REACHABLE via a discovery keyword. */
async function publish(assetId: string, keyword = `fav${++seq}`) {
  await on.app.inject({
    method: 'POST',
    url: '/admin/discovery/categories',
    payload: { name: `Fav ${keyword}`, keywords: [keyword] },
    cookies: adminCookies,
  });
  await on.app.inject({
    method: 'PUT',
    url: `/admin/discovery/content/${assetId}/keywords`,
    payload: { keywords: [keyword] },
    cookies: adminCookies,
  });
}

/** An eligible character: one approved, publicly reachable video. */
async function makeEligible(characterId: string) {
  const asset = await makeAsset(characterId, { video: true });
  await publish(asset.id);
  return asset;
}

const api = {
  home: () => on.app.inject({ method: 'GET', url: '/api/home' }),
  swipe: () => on.app.inject({ method: 'GET', url: '/api/play-with-me' }),
  favourites: (cookies = userCookies) =>
    on.app.inject({ method: 'GET', url: '/api/favourites', cookies }),
  save: (characterId: string, cookies = userCookies) =>
    on.app.inject({ method: 'PUT', url: `/api/favourites/${characterId}`, cookies }),
  unsave: (characterId: string, cookies = userCookies) =>
    on.app.inject({ method: 'DELETE', url: `/api/favourites/${characterId}`, cookies }),
};

const idsOf = (cards: Array<{ id: string }>) => cards.map((c) => c.id);

/* ------------------------------------------------------------------ *
 * 1. One population: Play with me IS Swipe
 * ------------------------------------------------------------------ */

describe('Play with me and Swipe are one population', () => {
  it('serves byte-identical card lists, in the same order', async () => {
    await makeEligible(LUNA.id);
    await makeEligible(EMBER.id);

    const rail = (await api.home()).json().playWithMe;
    const deck = (await api.swipe()).json().characters;

    expect(deck).toEqual(rail);
    expect(idsOf(deck).sort()).toEqual([EMBER.id, LUNA.id].sort());
  });

  it('stays identical as eligibility changes underneath them', async () => {
    await makeEligible(LUNA.id);
    expect(idsOf((await api.swipe()).json().characters)).toEqual([LUNA.id]);

    await makeEligible(MARIA.id);
    const rail = (await api.home()).json().playWithMe;
    const deck = (await api.swipe()).json().characters;
    expect(deck).toEqual(rail);
    expect(idsOf(deck).sort()).toEqual([LUNA.id, MARIA.id].sort());
  });

  /**
   * The defect this feature exists to close. `/api/characters` is every ACTIVE
   * character regardless of what she has published; the deck used to populate
   * itself from it, so it always contained more people than the rail and the
   * client invented media for the difference.
   */
  it('is NOT the general character list — that list is deliberately larger', async () => {
    await makeEligible(LUNA.id);

    const all = (await on.app.inject({ method: 'GET', url: '/api/characters' })).json();
    const deck = (await api.swipe()).json().characters;

    expect(all.length).toBeGreaterThan(deck.length);
    expect(idsOf(deck)).toEqual([LUNA.id]);
  });

  it('is empty when nothing is published — never padded out', async () => {
    expect((await api.swipe()).json().characters).toEqual([]);
    expect((await api.home()).json().playWithMe).toEqual([]);
  });

  it('needs no account: browsing is public, saving is not', async () => {
    await makeEligible(LUNA.id);
    expect((await api.swipe()).statusCode).toBe(200);
    expect((await api.favourites({})).statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Ineligible characters never enter these surfaces
 * ------------------------------------------------------------------ */

describe('ineligible characters cannot enter Swipe', () => {
  it('a character with NOTHING published is absent', async () => {
    await makeEligible(LUNA.id);
    const deck = (await api.swipe()).json().characters;
    expect(idsOf(deck)).not.toContain(EMBER.id);
  });

  it('an UNAPPROVED video does not make her eligible', async () => {
    const asset = await makeAsset(EMBER.id, { video: true, approved: false });
    await publish(asset.id);
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(EMBER.id);
  });

  it('an approved video that is published NOWHERE does not make her eligible', async () => {
    await makeAsset(EMBER.id, { video: true }); // approved, but unreachable
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(EMBER.id);
  });

  it('an approved IMAGE does not make her eligible — these are video surfaces', async () => {
    const asset = await makeAsset(EMBER.id, { video: false });
    await publish(asset.id);
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(EMBER.id);
  });

  it('a REFERENCE asset is her identity, not her content, and never qualifies', async () => {
    const asset = await makeAsset(EMBER.id, { video: true, kind: 'reference' });
    await publish(asset.id);
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(EMBER.id);
  });

  it('an INACTIVE character is absent even with an eligible video', async () => {
    await makeEligible(EMBER.id);
    expect(idsOf((await api.swipe()).json().characters)).toContain(EMBER.id);

    await on.db
      .update(characters)
      .set({ status: 'inactive' })
      .where(eq(characters.id, EMBER.id));
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(EMBER.id);
  });

  it('losing her last approved video removes her from the deck', async () => {
    const asset = await makeEligible(LUNA.id);
    expect(idsOf((await api.swipe()).json().characters)).toContain(LUNA.id);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(LUNA.id);
  });
});

/* ------------------------------------------------------------------ *
 * 3. No placeholder, demo or profile-image fallback can reach a payload
 * ------------------------------------------------------------------ */

describe('every card carries real published content and nothing else', () => {
  it('never emits a null clip, an image clip, or a card without one', async () => {
    await makeEligible(LUNA.id);
    await makeEligible(EMBER.id);
    // Maria is ACTIVE and has only an approved still — she must not appear
    // wearing it. Using an already-inactive character here would have made this
    // pass for the wrong reason.
    await publish((await makeAsset(MARIA.id, { video: false })).id);

    for (const card of (await api.swipe()).json().characters) {
      expect(card.clip).not.toBeNull();
      expect(card.clip.mediaType).toBe('video');
      expect(card.clip.characterId).toBe(card.id);
    }
    expect(idsOf((await api.swipe()).json().characters)).not.toContain(MARIA.id);
  });

  it('serves clips only through the opaque media route — never a storage path', async () => {
    await makeEligible(LUNA.id);
    const body = (await api.swipe()).body;

    expect(JSON.parse(body).characters[0].clip.url).toMatch(
      /^\/api\/media\/assets\/[0-9a-f-]{36}\/file$/,
    );
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('favourites-test');
    expect(body).not.toContain('.webm');
  });

  /**
   * The card shape carries no field the client could fall back TO. There is no
   * profileImage, no canonical image and no identity payload on it, so the
   * "show her portrait instead" branch has no data to run on even if a client
   * wanted it.
   */
  it('carries no profileImage or reference-image field at all', async () => {
    await makeEligible(LUNA.id);
    const card = (await api.swipe()).json().characters[0];

    expect(Object.keys(card).sort()).toEqual([
      'apparentAgeBand',
      'categories',
      'clip',
      'displayName',
      'id',
    ]);
    expect((await api.swipe()).body).not.toContain('profileImage');
  });

  it('the chosen clip really is fetchable — the card and the media route agree', async () => {
    const asset = await makeEligible(LUNA.id);
    const card = (await api.swipe()).json().characters[0];
    expect(card.clip.id).toBe(asset.id);

    const media = await on.app.inject({ method: 'GET', url: card.clip.url });
    expect(media.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Swiping: right saves, left does not, right never removes
 * ------------------------------------------------------------------ */

describe('swiping right saves a character', () => {
  it('creates the favourite and reports it as new', async () => {
    await makeEligible(LUNA.id);
    const res = await api.save(LUNA.id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ favourited: true });

    expect((await api.favourites()).json().characterIds).toEqual([LUNA.id]);
  });

  it('is IDEMPOTENT: a second right swipe leaves her favourited, once', async () => {
    await makeEligible(LUNA.id);
    expect((await api.save(LUNA.id)).statusCode).toBe(201);

    const again = await api.save(LUNA.id);
    // 200, not 409 and not a toggle: the desired state already holds.
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ favourited: true });

    const rows = await on.db.select().from(favourites);
    expect(rows).toHaveLength(1);
    expect((await api.favourites()).json().characterIds).toEqual([LUNA.id]);
  });

  it('preserves the original save time — a repeat does not resurface her', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    const [first] = await on.db.select().from(favourites);

    await api.save(LUNA.id);
    const [second] = await on.db.select().from(favourites);
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime());
  });

  /**
   * A LEFT SWIPE WRITES NOTHING. There is no pass endpoint and no pass table,
   * so this is structural rather than conditional: passing cannot reach the
   * database at all, and it therefore cannot disturb a favourite the user
   * already has.
   */
  it('a pass has no endpoint to call and leaves existing favourites intact', async () => {
    await makeEligible(LUNA.id);
    await makeEligible(EMBER.id);
    await api.save(LUNA.id);

    // Everything the deck could possibly do on a pass is browse.
    await api.swipe();
    await api.home();

    expect((await api.favourites()).json().characterIds).toEqual([LUNA.id]);
    expect(await on.db.select().from(favourites)).toHaveLength(1);
  });

  it('saving one character does not touch another', async () => {
    await makeEligible(LUNA.id);
    await makeEligible(EMBER.id);
    await api.save(LUNA.id);
    await api.save(EMBER.id);
    await api.save(LUNA.id);

    expect((await api.favourites()).json().characterIds.sort()).toEqual(
      [EMBER.id, LUNA.id].sort(),
    );
  });

  it('refuses an unknown or retired character without leaking which', async () => {
    const unknown = await api.save('11111111-1111-4111-8111-111111111111');
    expect(unknown.statusCode).toBe(404);

    // Sage is seeded inactive; Maria is retired here, so both the standing
    // state and the transition are covered.
    expect((await api.save(SAGE.id)).statusCode).toBe(404);
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, MARIA.id));
    expect((await api.save(MARIA.id)).statusCode).toBe(404);
    expect(await on.db.select().from(favourites)).toHaveLength(0);
  });

  it('reads a malformed id as not-found rather than erroring', async () => {
    expect((await api.save('not-a-uuid')).statusCode).toBe(404);
    expect((await api.unsave('not-a-uuid')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The heart: the only way to remove, and a readout of what is stored
 * ------------------------------------------------------------------ */

describe('the heart removes, and reflects the persisted state', () => {
  it('removes the favourite and reports it gone', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    const res = await api.unsave(LUNA.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ favourited: false });

    expect((await api.favourites()).json().characterIds).toEqual([]);
    expect(await on.db.select().from(favourites)).toHaveLength(0);
  });

  it('removing something not saved is a no-op, not an error', async () => {
    await makeEligible(LUNA.id);
    expect((await api.unsave(LUNA.id)).statusCode).toBe(200);
    expect((await api.favourites()).json().characterIds).toEqual([]);
  });

  it('save → remove → save again all work, in that order', async () => {
    await makeEligible(LUNA.id);
    expect((await api.save(LUNA.id)).statusCode).toBe(201);
    await api.unsave(LUNA.id);
    expect((await api.favourites()).json().characterIds).toEqual([]);
    expect((await api.save(LUNA.id)).statusCode).toBe(201);
    expect((await api.favourites()).json().characterIds).toEqual([LUNA.id]);
  });

  /**
   * `characterIds` is the RAW relationship, deliberately unfiltered by
   * eligibility — it is what the heart renders. A character whose content was
   * withdrawn is still saved, and her heart must stay filled through it.
   */
  it('keeps her in characterIds when her content disappears', async () => {
    const asset = await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    const body = (await api.favourites()).json();
    expect(body.characterIds).toEqual([LUNA.id]); // heart: still filled
    expect(body.favourites[0].clip).toBeNull(); // gallery: no tile
  });
});

/* ------------------------------------------------------------------ *
 * 6. Persistence and privacy
 * ------------------------------------------------------------------ */

describe('favourites persist and are private', () => {
  it('survives a brand-new session — the row, not the cookie, is the truth', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    const fresh = await signIn('fav.user@example.com');
    expect((await api.favourites(fresh)).json().characterIds).toEqual([LUNA.id]);
  });

  it('is invisible to another account, which cannot delete it either', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    const other = await register('fav.other@example.com', 'user');
    expect((await api.favourites(other)).json().characterIds).toEqual([]);

    await api.unsave(LUNA.id, other);
    expect((await api.favourites()).json().characterIds).toEqual([LUNA.id]);
  });

  it('requires a session on every route', async () => {
    await makeEligible(LUNA.id);
    expect((await api.favourites({})).statusCode).toBe(401);
    expect((await api.save(LUNA.id, {})).statusCode).toBe(401);
    expect((await api.unsave(LUNA.id, {})).statusCode).toBe(401);
    expect(await on.db.select().from(favourites)).toHaveLength(0);
  });

  it('goes with the account when the account goes', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    await on.pool.query(`DELETE FROM users WHERE email = $1`, ['fav.user@example.com']);
    expect(await on.db.select().from(favourites)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. The gallery: one CURRENT clip per favourite, resolved not stored
 * ------------------------------------------------------------------ */

describe('the Favourites gallery resolves current content', () => {
  it('lists the saved characters with exactly one clip each', async () => {
    await makeEligible(LUNA.id);
    await makeEligible(EMBER.id);
    await makeEligible(MARIA.id);
    await api.save(LUNA.id);
    await api.save(EMBER.id);

    const body = (await api.favourites()).json();
    expect(idsOf(body.favourites).sort()).toEqual([EMBER.id, LUNA.id].sort());
    // Saved only. An eligible character nobody saved is not in Favourites.
    expect(idsOf(body.favourites)).not.toContain(MARIA.id);

    for (const card of body.favourites) {
      expect(card.clip).not.toBeNull();
      expect(card.clip.mediaType).toBe('video');
      expect(card.clip.characterId).toBe(card.id);
    }
    // One clip per character — the payload cannot carry a second.
    expect(body.favourites.every((c: { clip: unknown }) => !Array.isArray(c.clip))).toBe(true);
  });

  it('serves the SAME card shape Play with me serves', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    const railCard = (await api.swipe()).json().characters.find(
      (c: { id: string }) => c.id === LUNA.id,
    );
    const favCard = (await api.favourites()).json().favourites[0];
    expect(favCard).toEqual(railCard);
  });

  /**
   * THE POINT OF STORING NO MEDIA. An operator replaces her published clip and
   * the gallery follows on the very next request, with nothing to migrate.
   */
  it('follows a replaced clip automatically', async () => {
    const first = await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    expect((await api.favourites()).json().favourites[0].clip.id).toBe(first.id);

    // A newer approved, publicly reachable video wins the representative slot.
    const second = await makeEligible(LUNA.id);
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(characterVisualAssets.id, second.id));

    expect((await api.favourites()).json().favourites[0].clip.id).toBe(second.id);
  });

  it('the favourite row itself holds no media locator', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    const [row] = await on.db.select().from(favourites);
    expect(Object.keys(row!).sort()).toEqual(['characterId', 'createdAt', 'userId']);
  });

  /**
   * A FAVOURITE WITH NO CURRENT CONTENT PRODUCES NO SUBSTITUTE. The card comes
   * back with a null clip so the client knows the row survives; there is no
   * portrait, no profileImage and no placeholder anywhere in the response.
   */
  it('returns a null clip rather than a substitute image', async () => {
    const asset = await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    // Her only content is withdrawn, and a reference image is added — the exact
    // shape that used to be promoted into the empty slot.
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));
    await publish((await makeAsset(LUNA.id, { video: true, kind: 'reference' })).id);

    const res = await api.favourites();
    const body = res.json();
    expect(body.characterIds).toEqual([LUNA.id]);
    expect(body.favourites[0].clip).toBeNull();
    expect(res.body).not.toContain('profileImage');
    expect(res.body).not.toContain(testEnv.media.storageDir);
  });

  it('brings her back automatically when eligible content returns', async () => {
    const asset = await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.favourites()).json().favourites[0].clip).toBeNull();

    await makeEligible(LUNA.id);
    expect((await api.favourites()).json().favourites[0].clip).not.toBeNull();
  });

  it('omits an inactive character from the gallery but keeps her saved', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));

    const body = (await api.favourites()).json();
    expect(body.favourites).toEqual([]);
    expect(body.characterIds).toEqual([LUNA.id]);
  });

  it('is empty, not absent, for a user who has saved nobody', async () => {
    await makeEligible(LUNA.id);
    expect((await api.favourites()).json()).toEqual({ favourites: [], characterIds: [] });
  });
});

/* ------------------------------------------------------------------ *
 * 8. Unrelated surfaces are unaffected
 * ------------------------------------------------------------------ */

describe('existing surfaces are unchanged', () => {
  it('/api/characters still returns every active character, favourites or not', async () => {
    await makeEligible(LUNA.id);
    await api.save(LUNA.id);

    const all = (await on.app.inject({ method: 'GET', url: '/api/characters' })).json();
    // Every ACTIVE character. Sage is seeded inactive and has never been in
    // this list, which is exactly why the deck could not be built from it.
    expect(all.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([LUNA.id, EMBER.id, MARIA.id]),
    );
    expect(JSON.stringify(all)).not.toContain('favourite');
  });

  it('the character profile still serves her own RELEASED clips', async () => {
    /**
     * MERCHANDISING IS NOT PUBLICATION, and this test had to learn it.
     *
     * It used to rely on `makeEligible` alone — an approved clip made reachable
     * from Home by a discovery keyword — and expect it on her Posts tab. That
     * was the defect: Posts answered a HOME placement question. Posts now asks
     * whether the clip was released to HER page, so the test performs that
     * release explicitly.
     */
    const asset = await makeEligible(LUNA.id);
    await on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/publish`,
      cookies: adminCookies,
    });
    const res = await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}/clips` });
    expect(res.statusCode).toBe(200);
    expect(res.json().clips.map((c: { id: string }) => c.id)).toContain(asset.id);
  });

  it('the visual-identity read is untouched', async () => {
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${LUNA.id}/visual-identity`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('canonicalAssets');
  });

  it('Home still composes its other sections', async () => {
    await makeEligible(LUNA.id);
    const home = (await api.home()).json();
    for (const key of ['banners', 'hero', 'categories', 'categoryPills', 'browseClips']) {
      expect(home).toHaveProperty(key);
    }
  });
});
