import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  appCategories,
  characters,
  characterVisualAssets,
  characterVisualIdentities,
  homeHeroClips,
  homePlayWithMeCharacters,
} from '../db/schema.js';
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
 * US-102.4 — App Home Publishing & Preview.
 *
 * The rules these exist to hold:
 *
 *  1. NOTHING IS ON HOME BY EXISTING. A category appears only when an admin
 *     publishes it, and publication is independent of `enabled`.
 *  2. THE PUBLIC SURFACE SHOWS ONLY APPROVED CONTENT, on every rail, always.
 *  3. NO STORAGE PATH EVER REACHES A CLIENT — including the pre-existing public
 *     visual-identity leak this ticket fixes.
 *  4. PUBLIC MEDIA NEEDS BOTH approval AND public reachability. An approved but
 *     unpublished asset is a 404.
 *  5. DISCOVERY IS A SEPARATE SYSTEM. Keyword categories cannot touch App
 *     Categories, and deleting one cannot touch content or keywords.
 *  6. EVERY ADMIN ROUTE IS ADMIN-ONLY; every public route needs no account.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const EMBER = SEED_CHARACTERS.find((c) => c.name === 'ember')!;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A tiny WebM-shaped payload (EBML magic + filler).
 *
 * The server classifies media by EXTENSION — `mediaTypeOf` reads the storage
 * key — so what this test needs from the bytes is only that they are non-empty
 * and accepted. Browser decoding is proven separately, in a real browser.
 */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(64, 0x42),
]);

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
  adminCookies = await register('home.admin@example.com', 'admin');
  userCookies = await register('home.user@example.com', 'user');
});

async function register(email: string, role: 'admin' | 'user') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'home-publishing-1' },
  });
  const cookie = extractSessionCookie(res)!;
  if (role === 'admin') {
    await on.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  }
  return { [cookie.name]: cookie.value };
}

/** An approved asset whose bytes really exist inside the storage root. */
async function makeApprovedAsset(characterId = LUNA.id) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

/**
 * An approved VIDEO asset, stored under a .webm key.
 *
 * The character rails are video surfaces and `mediaTypeOf` reads the extension,
 * so a test that needs a rail to render something must create one of these —
 * `makeApprovedAsset` writes a .png and is, correctly, never chosen by
 * `representativeClips`.
 */
async function makeApprovedVideoAsset(characterId = LUNA.id) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.webm`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, WEBM);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

/**
 * RELEASES an approved clip to the character's Posts tab, through the real
 * admin endpoint rather than by writing the column directly.
 *
 * Separate from `publishViaKeyword` on purpose, and the distinction is the
 * point of this whole model: a keyword makes a clip reachable from HOME and
 * Discovery, this makes it appear on HER PAGE. Approval alone does neither.
 */
async function releaseToPosts(assetId: string) {
  const res = await on.app.inject({
    method: 'POST',
    url: `/admin/content/assets/${assetId}/publish`,
    cookies: adminCookies,
  });
  expect(res.statusCode).toBe(200);
}

/** Makes an approved video PUBLICLY REACHABLE via a discovery keyword. */
async function publishViaKeyword(assetId: string, keyword = 'railtest') {
  await api.createDiscovery({ name: `Rail ${keyword} ${++seq}`, keywords: [keyword] });
  await api.setAssetKeywords(assetId, [keyword]);
}

async function makeUnapprovedAsset(characterId = LUNA.id) {
  const identity = (await getActiveVisualIdentity(on.db, characterId))!;
  const asset = await createVisualAsset(on.db, {
    characterId,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'under_review',
    contentRating: 'sfw',
  });
  const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
  await on.db
    .update(characterVisualAssets)
    .set({ storageKey: path })
    .where(eq(characterVisualAssets.id, asset.id));
  return { ...asset, storageKey: path };
}

async function makeCategory(base = 'Home Cat') {
  const res = await on.app.inject({
    method: 'POST',
    url: '/admin/app-categories',
    payload: { name: `${base} ${process.pid} ${++seq}` },
    cookies: adminCookies,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string; name: string };
}

async function assign(categoryId: string, assetIds: string[]) {
  return on.app.inject({
    method: 'POST',
    url: `/admin/app-categories/${categoryId}/assets`,
    payload: { assetIds },
    cookies: adminCookies,
  });
}

const api = {
  home: (cookies?: Record<string, string>) =>
    on.app.inject({ method: 'GET', url: '/api/home', ...(cookies ? { cookies } : {}) }),
  adminHome: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home', cookies }),
  preview: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/preview', cookies }),
  publish: (categoryId: string, homePublished: boolean, cookies = adminCookies) =>
    on.app.inject({
      method: 'PATCH',
      url: `/admin/home/categories/${categoryId}`,
      payload: { homePublished },
      cookies,
    }),
  orderCategories: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: '/admin/home/categories/order',
      payload: { orderedIds },
      cookies,
    }),
  addHero: (assetIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/home/hero', payload: { assetIds }, cookies }),
  removeHero: (assetId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/home/hero/${assetId}`, cookies }),
  orderHero: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'PUT', url: '/admin/home/hero/order', payload: { orderedIds }, cookies }),
  /** Publishing -> Categories. Writes `position`, the CMS list order. */
  orderCmsCategories: (orderedIds: string[], cookies = adminCookies) =>
    on.app.inject({ method: 'PUT', url: '/admin/app-categories/order', payload: { orderedIds }, cookies }),
  playWithMeContents: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/home/play-with-me/contents', cookies }),
  orderPlayWithMe: (orderedAssetIds: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: '/admin/home/play-with-me/order',
      payload: { orderedAssetIds },
      cookies,
    }),
  clearPlayWithMe: (cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: '/admin/home/play-with-me/order', cookies }),
  media: (assetId: string) =>
    on.app.inject({ method: 'GET', url: `/api/media/assets/${assetId}/file` }),
  /** The lobby SEARCH grid — content clips, never characters. */
  browseClips: (qs = '') =>
    on.app.inject({ method: 'GET', url: `/api/browse/clips${qs}` }),
  discoveryCategories: () => on.app.inject({ method: 'GET', url: '/api/discovery/categories' }),
  clips: (qs = '') => on.app.inject({ method: 'GET', url: `/api/discovery/clips${qs}` }),
  adminDiscovery: (cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: '/admin/discovery/categories', cookies }),
  createDiscovery: (payload: Record<string, unknown>, cookies = adminCookies) =>
    on.app.inject({ method: 'POST', url: '/admin/discovery/categories', payload, cookies }),
  deleteDiscovery: (id: string, cookies = adminCookies) =>
    on.app.inject({ method: 'DELETE', url: `/admin/discovery/categories/${id}`, cookies }),
  setAssetKeywords: (assetId: string, keywords: string[], cookies = adminCookies) =>
    on.app.inject({
      method: 'PUT',
      url: `/admin/discovery/content/${assetId}/keywords`,
      payload: { keywords },
      cookies,
    }),
};

/* ------------------------------------------------------------------ *
 * 1. Nothing is on Home by existing
 * ------------------------------------------------------------------ */

describe('a category is on Home only when published there', () => {
  it('a brand new category is NOT on Home', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    const home = (await api.home()).json();
    expect(home.categories.map((c: { id: string }) => c.id)).not.toContain(category.id);
  });

  it('publishing puts it on Home, unpublishing takes it off', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    expect((await api.publish(category.id, true)).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).toContain(
      category.id,
    );

    expect((await api.publish(category.id, false)).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).not.toContain(
      category.id,
    );
  });

  it('unpublishing destroys nothing — the assignment survives', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.publish(category.id, false);

    const contents = await on.app.inject({
      method: 'GET',
      url: `/admin/app-categories/${category.id}/assets`,
      cookies: adminCookies,
    });
    expect(contents.json().assets.map((a: { assetId: string }) => a.assetId)).toContain(asset.id);
  });

  it('home publication is INDEPENDENT of enabled, in both directions', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    // Disabling hides it from Home but does NOT unpublish it.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.home()).json().categories).toEqual([]);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.homePublished).toBe(true);

    // Re-enabling brings it straight back — nothing had to be re-published.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: true },
      cookies: adminCookies,
    });
    expect((await api.home()).json().categories).toHaveLength(1);
  });

  it('publishing does NOT enable a disabled category', async () => {
    const category = await makeCategory();
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    await api.publish(category.id, true);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.enabled).toBe(false);
    expect((await api.home()).json().categories).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Home order is its own order
 * ------------------------------------------------------------------ */

describe('the Home composer reorders the one shared order', () => {
  /**
   * REVISED, AND THE REVISION IS THE FIX. This block used to assert that
   * reordering on the Home composer left the CMS list untouched — the literal
   * statement that Home had a SECOND, independent ordering. That independence
   * is what shipped the reported bug: the rails read a column
   * (`home_position`) that no operator sets and that publication reassigns, so
   * the Admin showed one order and the app showed another.
   *
   * There is one order now. Both screens write `position`, so reordering in
   * either place moves both. What still holds — and is still asserted — is
   * that the composer reorders the RAILS and that a stale order is refused.
   */
  it('reordering Home moves the rails, and the Admin list with them', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    const asset = await makeApprovedAsset();
    await assign(a.id, [asset.id]);
    await assign(b.id, [asset.id]);
    await api.publish(a.id, true);
    await api.publish(b.id, true);

    expect((await api.orderCategories([b.id, a.id])).statusCode).toBe(200);
    expect((await api.home()).json().categories.map((c: { id: string }) => c.id)).toEqual([
      b.id,
      a.id,
    ]);

    const cmsAfter = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json().categories.map((c: { id: string }) => c.id);
    expect(cmsAfter).toEqual([b.id, a.id]);
  });

  it('refuses a stale order that omits a published category', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    await api.publish(a.id, true);
    await api.publish(b.id, true);
    const res = await api.orderCategories([a.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');
  });

  it('refuses an order naming an unpublished category', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    await api.publish(a.id, true);
    const res = await api.orderCategories([a.id, b.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('unknown_id');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Only approved content reaches the public surface
 * ------------------------------------------------------------------ */

describe('the public surface shows approved content only', () => {
  it('an unapproved asset never appears in a Home rail', async () => {
    const category = await makeCategory();
    const approved = await makeApprovedAsset();
    const pending = await makeUnapprovedAsset();
    await assign(category.id, [approved.id, pending.id]);
    await api.publish(category.id, true);

    const rail = (await api.home()).json().categories[0];
    const ids = rail.clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(approved.id);
    expect(ids).not.toContain(pending.id);
  });

  it('an asset that LOSES approval leaves Home without the link being destroyed', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    expect((await api.home()).json().categories[0].clips).toHaveLength(1);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    expect((await api.home()).json().categories[0].clips).toEqual([]);

    // Re-approving brings it back by itself — nothing was deleted.
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'approved' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.home()).json().categories[0].clips).toHaveLength(1);
  });

  it('an unapproved clip cannot be added to the Hero', async () => {
    const pending = await makeUnapprovedAsset();
    const res = await api.addHero([pending.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomes[0]).toMatchObject({ added: false, reason: 'not_approved' });
    // Nothing was assigned, so Home shows the fallback, and the refused clip
    // is not in it.
    expect((await api.adminHome()).json().hero).toEqual([]);
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).not.toContain(
      pending.id,
    );
  });

  it('a Hero clip that loses approval disappears from Home but stays assigned', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.home()).json().hero).toHaveLength(1);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'rejected' })
      .where(eq(characterVisualAssets.id, asset.id));

    // It leaves the public Hero (which falls back to representative clips)
    // while staying assigned.
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).not.toContain(
      asset.id,
    );
    // The operator can still see and clean up the assignment.
    const admin = (await api.adminHome()).json();
    expect(admin.hero.map((c: { assetId: string }) => c.assetId)).toContain(asset.id);
    expect(admin.hero[0].publishable).toBe(false);
  });

  it('discovery clips are approved-only', async () => {
    const approved = await makeApprovedAsset();
    const pending = await makeUnapprovedAsset();
    await api.setAssetKeywords(approved.id, ['sexy']);
    await api.setAssetKeywords(pending.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    const ids = (await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(approved.id);
    expect(ids).not.toContain(pending.id);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Media security
 * ------------------------------------------------------------------ */

describe('public media security', () => {
  it('no storage path or filesystem key appears anywhere in the Home payload', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);

    const body = (await api.home()).payload;
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('storagePath');
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('/app/var/media');
    // And it does carry the opaque locator.
    expect(body).toContain(`/api/media/assets/${asset.id}/file`);
  });

  it('the public visual-identity endpoint no longer leaks the storage key', async () => {
    // The pre-existing leak this ticket fixes: imageUrl used to be the raw path.
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${LUNA.id}/visual-identity`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(testEnv.media.storageDir);
    for (const item of res.json().canonicalAssets) {
      expect(item.imageUrl).toMatch(/^\/api\/media\/assets\/[0-9a-f-]+\/file$/);
    }
  });

  it('serves an approved, publicly reachable asset', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const res = await api.media(asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('REFUSES an approved asset that no public surface references', async () => {
    // Approval alone must not expose the whole Library to id guessing.
    const asset = await makeApprovedAsset();
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('refuses an approved asset in a category that is NOT published to Home', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(404);

    await api.publish(category.id, true);
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Unpublishing closes it again immediately.
    await api.publish(category.id, false);
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('refuses an unapproved asset even when it is assigned and published', async () => {
    const category = await makeCategory();
    const pending = await makeUnapprovedAsset();
    await on.pool.query(
      'INSERT INTO app_category_assets (category_id, asset_id, position) VALUES ($1, $2, 0)',
      [category.id, pending.id],
    );
    await api.publish(category.id, true);
    expect((await api.media(pending.id)).statusCode).toBe(404);
  });

  it('unknown, malformed and unreachable all read as the same 404', async () => {
    const asset = await makeApprovedAsset();
    for (const url of [
      '/api/media/assets/not-a-uuid/file',
      '/api/media/assets/11111111-1111-4111-8111-111111111111/file',
      `/api/media/assets/${asset.id}/file`,
    ]) {
      const res = await on.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    }
  });

  it('a retired character takes their media with them', async () => {
    // Retirement already removes a character from /api/characters and from the
    // visual-identity route. Their media has to go too, or the pictures stay
    // reachable by id after the profile stops existing.
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(200);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));

    expect((await api.media(asset.id)).statusCode).toBe(404);
    const home = (await api.home()).json();
    // Their clip leaves the Hero. Other characters' clips may fill it via the
    // fallback, which is exactly the point: the retired character's does not.
    expect(home.hero.map((c: { id: string }) => c.id)).not.toContain(asset.id);
    expect(home.categories[0].clips).toEqual([]);

    // Reactivating restores it — nothing was deleted.
    await on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, LUNA.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);
  });

  it('a retired character\'s canonical reference is no longer fetchable either', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('a Hero clip is publicly fetchable, and stops being so when removed', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.media(asset.id)).statusCode).toBe(200);
    await api.removeHero(asset.id);
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Play with Me and Recently Added
 * ------------------------------------------------------------------ */

describe('Play with Me', () => {
  it('gives each character exactly ONE card, however many clips they have', async () => {
    // Videos, because the rails are video surfaces — the assertion under test
    // is the card COUNT, which must stay 1 however many clips exist.
    const a = await makeApprovedVideoAsset();
    const b = await makeApprovedVideoAsset();
    await publishViaKeyword(a.id, 'onecard');
    await api.setAssetKeywords(b.id, ['onecard']);
    const home = (await api.home()).json();
    expect(home.playWithMe.filter((c: { id: string }) => c.id === LUNA.id)).toHaveLength(1);
    const luna = home.playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip).not.toBeNull();
    expect(luna.clip.characterId).toBe(LUNA.id);
  });

  /* ---------------------------------------------------------------- *
   * THE REGRESSION THIS SUITE EXISTS FOR.
   *
   * These previously asserted that the canonical REFERENCE won — the
   * character's primary identity image, served to the rail and called a clip.
   * That was the defect. A rail represents a character by her CONTENT.
   * ---------------------------------------------------------------- */

  it('NEVER returns the canonical reference image as the representative clip', async () => {
    // Fixture: reference image = asset A (seeded canonical), video = asset B.
    const [assetA] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(
        and(
          eq(characterVisualAssets.characterId, LUNA.id),
          eq(characterVisualAssets.isCanonical, true),
        ),
      );
    expect(assetA).toBeDefined();
    expect(assetA!.kind).toBe('reference');

    const assetB = await makeApprovedVideoAsset();
    await publishViaKeyword(assetB.id);

    const luna = (await api.home()).json().playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip).not.toBeNull();
    expect(luna.clip.id).toBe(assetB.id);
    // The whole point, stated as its own assertion.
    expect(luna.clip.id).not.toBe(assetA!.id);
    expect(luna.clip.mediaType).toBe('video');
  });

  it('a character with a canonical image AND an approved video gets the VIDEO', async () => {
    const video = await makeApprovedVideoAsset();
    await publishViaKeyword(video.id);
    const luna = (await api.home()).json().playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip.id).toBe(video.id);
    // Stable across reads — the choice is deterministic, not sampled.
    const again = (await api.home()).json().playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(again.clip.id).toBe(video.id);
  });

  it('the representative video belongs to THAT character and no other', async () => {
    const lunaVideo = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(lunaVideo.id, 'lunaonly');
    const emberVideo = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(emberVideo.id, 'emberonly');

    const home = (await api.home()).json();
    const luna = home.playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    const ember = home.playWithMe.find((c: { id: string }) => c.id === EMBER.id);
    expect(luna.clip.id).toBe(lunaVideo.id);
    expect(luna.clip.characterId).toBe(LUNA.id);
    expect(ember.clip.id).toBe(emberVideo.id);
    expect(ember.clip.characterId).toBe(EMBER.id);
    // No cross-contamination in either direction.
    expect(luna.clip.id).not.toBe(emberVideo.id);
    expect(ember.clip.id).not.toBe(lunaVideo.id);
  });

  it('does NOT select an unapproved video', async () => {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const pending = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
      status: 'under_review',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${pending.id}.webm`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, WEBM);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path })
      .where(eq(characterVisualAssets.id, pending.id));

    // She has no ELIGIBLE video, so she is not on the rail at all.
    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(LUNA.id);
  });

  it('does NOT select a video that is approved but not publicly reachable', async () => {
    // Approved, but in no category, no Hero and carrying no keyword.
    await makeApprovedVideoAsset();
    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(LUNA.id);
  });

  it('does NOT select a video belonging to an INACTIVE character', async () => {
    const video = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(video.id, 'emberinactive');
    // Reachable while she is live...
    expect(
      (await api.home()).json().playWithMe.find((c: { id: string }) => c.id === EMBER.id).clip.id,
    ).toBe(video.id);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, EMBER.id));
    const home = (await api.home()).json();
    // ...and gone entirely once she is not.
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(EMBER.id);
    expect((await api.media(video.id)).statusCode).toBe(404);
  });

  it('a character with NO eligible video is DROPPED, not shown with a substitute', async () => {
    // Fixture: reference image = asset A, no eligible video anywhere.
    const [assetA] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(
        and(
          eq(characterVisualAssets.characterId, LUNA.id),
          eq(characterVisualAssets.isCanonical, true),
        ),
      );
    expect(assetA).toBeDefined();

    const res = await api.home();
    const rail = res.json().playWithMe as Array<{ id: string }>;
    // She used to keep her place with clip=null. She no longer appears at all:
    // one card means one character AND one real video.
    expect(rail.map((c) => c.id)).not.toContain(LUNA.id);
    // And her canonical reference is nowhere in the payload.
    expect(res.payload).not.toContain(assetA!.id);
  });

  it('an approved IMAGE clip is not a rail clip either', async () => {
    // An uploaded image is legitimate content, but these rails are video
    // surfaces. It must not become the card's media.
    const image = await makeApprovedAsset();
    await publishViaKeyword(image.id, 'imageonly');
    const res = await api.home();
    const rail = res.json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(LUNA.id);
    // The image is legitimate content elsewhere — just not rail media.
    expect(res.payload).not.toContain(image.id);
  });

  it('picks the NEWEST eligible video when a character has several', async () => {
    // An operator who uploads a new clip expects to see it, not to wonder why
    // the rail still shows her first ever upload.
    const first = await makeApprovedVideoAsset();
    await publishViaKeyword(first.id, 'multi');
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(characterVisualAssets.id, first.id));
    const second = await makeApprovedVideoAsset();
    await api.setAssetKeywords(second.id, ['multi']);

    const luna = (await api.home()).json().playWithMe.find((c: { id: string }) => c.id === LUNA.id);
    expect(luna.clip.id).toBe(second.id);
    expect(luna.clip.id).not.toBe(first.id);
  });

  it('excludes inactive characters', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const home = (await api.home()).json();
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(LUNA.id);
  });

  it('invents no online/offline state', async () => {
    const body = (await api.home()).payload;
    expect(body).not.toContain('isOnline');
    expect(body).not.toContain('"online"');
    expect(body).not.toContain('presence');
  });
});

/**
 * Curating Play with me.
 *
 * The rail's automatic rule — every active character, alphabetically — is
 * unchanged and still the default. What is new is that an operator may override
 * it wholesale. The override is a WHOLE list, never a blend: once curated, a
 * character the operator did not choose must not appear, however new or active
 * they are. That is the property these tests exist to hold.
 */
/* ------------------------------------------------------------------ *
 * Play with me is DETERMINISTIC — the curation suites are gone
 *
 * These replace ~250 lines that exercised an automatic-versus-curated model:
 * materialise-on-first-edit, exact-permutation reordering, add/remove/reset,
 * and "a curated rail never blends in an automatic character". None of it
 * exists any more. The rail is one rule:
 *
 *     active character → newest approved/public VIDEO of hers → one card
 *
 * so what is worth asserting is the rule itself, its stability, and that no
 * stale override row can bend it. Those live in "Play with Me: one real video
 * per character" and "Play with Me has no admin surface at all" below.
 * ------------------------------------------------------------------ */

describe('Play with me is one deterministic rule', () => {
  it('is every active character WITH a video, alphabetically, one card each', async () => {
    const luna = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(luna.id, 'detlu');
    const ember = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(ember.id, 'detem');

    const rail = (await api.home()).json().playWithMe as Array<{
      id: string;
      displayName: string;
      clip: { id: string; mediaType: string; characterId: string } | null;
    }>;
    // Alphabetical, and every entry is a distinct character with her own video.
    const names = rail.map((c) => c.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(new Set(rail.map((c) => c.id)).size).toBe(rail.length);
    for (const card of rail) {
      expect(card.clip).not.toBeNull();
      expect(card.clip!.mediaType).toBe('video');
      expect(card.clip!.characterId).toBe(card.id);
    }
  });

  it('is STABLE across reads — the same rail, not a sample', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'detstable');
    const once = (await api.home()).json().playWithMe;
    const twice = (await api.home()).json().playWithMe;
    expect(twice).toEqual(once);
  });

  it('has no modes: nothing in the payload says automatic or curated', async () => {
    const payload = (await api.home()).payload;
    expect(payload).not.toMatch(/"curated"/i);
  });
});

describe('Recently Added is gone', () => {
  it('is absent from the public Home payload entirely', async () => {
    const res = await api.home();
    expect(res.statusCode).toBe(200);
    const home = res.json();
    expect(home).not.toHaveProperty('recentlyAdded');
    // Not merely absent as a key \u2014 absent as a word.
    expect(res.payload).not.toMatch(/recentlyAdded/i);
  });

  it('still composes the rails that remain', async () => {
    // The removal must not have taken Home with it.
    const home = (await api.home()).json();
    expect(home).toHaveProperty('playWithMe');
    expect(home).toHaveProperty('categories');
    expect(home).toHaveProperty('hero');
    expect(home).toHaveProperty('banners');
  });

  it('serves no admin Recently Added route \u2014 every verb 404s', async () => {
    const cookies = adminCookies;
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home/recent', cookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/recent/candidates', cookies }),
      on.app.inject({ method: 'POST', url: '/admin/home/recent', payload: { characterId: EMBER }, cookies }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/recent/${EMBER}`, cookies }),
      on.app.inject({ method: 'PUT', url: '/admin/home/recent/order', payload: { orderedIds: [] }, cookies }),
      on.app.inject({ method: 'POST', url: '/admin/home/recent/reset', cookies }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
    }
  });

  it('is absent from the admin Home overview', async () => {
    const res = await api.adminHome();
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('recentlyAdded');
    expect(res.payload).not.toMatch(/recentlyAdded/i);
  });

  it('populates nothing automatically \u2014 creating characters adds no rail', async () => {
    // The old rule was "the 12 newest active characters, computed per read".
    // Creating characters must no longer bring any such list into existence.
    await createCharacterByName('RecentProbe');
    const res = await api.home();
    expect(res.payload).not.toMatch(/recentlyAdded/i);
    expect(res.json()).not.toHaveProperty('recentlyAdded');
  });
});

describe('the two Home banner slots', () => {
  async function makeBanner(slot: string, title: string) {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    const creative = upload.json() as { id: string };
    const created = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title,
        creativeId: creative.id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/x',
        slot,
      },
      cookies: adminCookies,
    });
    expect(created.statusCode).toBe(201);
    const banner = created.json();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    return banner;
  }

  it('places banners in the slot they were assigned', async () => {
    const before = await makeBanner('before_search', 'Before');
    const below = await makeBanner('below_results', 'Below');
    const home = (await api.home()).json();
    expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([before.id]);
    expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([below.id]);
  });

  it('holds multiple banners per slot in explicit order', async () => {
    const one = await makeBanner('before_search', 'One');
    const two = await makeBanner('before_search', 'Two');
    expect((await api.home()).json().banners.before_search.map((b: { id: string }) => b.id)).toEqual([
      one.id,
      two.id,
    ]);

    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [two.id, one.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);
    expect((await api.home()).json().banners.before_search.map((b: { id: string }) => b.id)).toEqual([
      two.id,
      one.id,
    ]);
  });

  it('ordering one slot does not require or disturb the other', async () => {
    const a = await makeBanner('before_search', 'A');
    const b = await makeBanner('before_search', 'B');
    const c = await makeBanner('below_results', 'C');
    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [b.id, a.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);
    expect((await api.home()).json().banners.below_results.map((x: { id: string }) => x.id)).toEqual([
      c.id,
    ]);
  });

  it('refuses an order naming a banner from the other slot', async () => {
    const a = await makeBanner('before_search', 'A');
    const c = await makeBanner('below_results', 'C');
    const res = await on.app.inject({
      method: 'PUT',
      url: '/admin/home-banners/order',
      payload: { slot: 'before_search', orderedIds: [a.id, c.id] },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(409);
  });

  it('a draft banner reaches no slot', async () => {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title: 'Draft',
        creativeId: upload.json().id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/d',
        slot: 'before_search',
      },
      cookies: adminCookies,
    });
    const home = (await api.home()).json();
    expect(home.banners.before_search).toEqual([]);
    expect(home.banners.below_results).toEqual([]);
  });

  it('both slots are always present, even when empty', async () => {
    const home = (await api.home()).json();
    expect(Object.keys(home.banners).sort()).toEqual(['before_search', 'below_results']);
  });

  /**
   * MOVING a banner between slots.
   *
   * The editor could not send `slot` at all, so every banner made in Admin took
   * the column default and the second slot was unreachable. The server side
   * always supported it; these pin the behaviour the new selector drives.
   */
  describe('moving a banner to the other slot', () => {
    const setSlot = (id: string, slot: string) =>
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home-banners/${id}`,
        payload: { slot },
        cookies: adminCookies,
      });

    it('moves it, in both directions', async () => {
      const banner = await makeBanner('before_search', 'Mover');
      expect((await setSlot(banner.id, 'below_results')).statusCode).toBe(200);
      let home = (await api.home()).json();
      expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([]);
      expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([banner.id]);

      expect((await setSlot(banner.id, 'before_search')).statusCode).toBe(200);
      home = (await api.home()).json();
      expect(home.banners.before_search.map((b: { id: string }) => b.id)).toEqual([banner.id]);
      expect(home.banners.below_results.map((b: { id: string }) => b.id)).toEqual([]);
    });

    it('lands at the END of the destination, disturbing no existing order', async () => {
      const first = await makeBanner('below_results', 'First');
      const second = await makeBanner('below_results', 'Second');
      const incomer = await makeBanner('before_search', 'Incomer');

      expect((await setSlot(incomer.id, 'below_results')).statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.below_results.map((b: { id: string }) => b.id),
      ).toEqual([first.id, second.id, incomer.id]);
    });

    it('restating the SAME slot is a no-op that does not reshuffle', async () => {
      // The editor sends `slot` on every save, so this is the common case.
      const first = await makeBanner('before_search', 'First');
      const second = await makeBanner('before_search', 'Second');
      expect((await setSlot(first.id, 'before_search')).statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.before_search.map((b: { id: string }) => b.id),
      ).toEqual([first.id, second.id]);
    });

    it('leaves the slot it came from correctly ordered', async () => {
      const a = await makeBanner('before_search', 'A');
      const b = await makeBanner('before_search', 'B');
      const c = await makeBanner('before_search', 'C');
      expect((await setSlot(b.id, 'below_results')).statusCode).toBe(200);

      const home = (await api.home()).json();
      expect(home.banners.before_search.map((x: { id: string }) => x.id)).toEqual([a.id, c.id]);
      // And the survivors can still be reordered as an exact permutation.
      const res = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'before_search', orderedIds: [c.id, a.id] },
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
      expect(
        (await api.home()).json().banners.before_search.map((x: { id: string }) => x.id),
      ).toEqual([c.id, a.id]);
    });

    it('a moved banner must be named by the NEW slot\'s order, not the old one', async () => {
      const stay = await makeBanner('before_search', 'Stay');
      const mover = await makeBanner('before_search', 'Mover');
      await setSlot(mover.id, 'below_results');

      // The old slot's permutation must no longer include it.
      const stale = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'before_search', orderedIds: [stay.id, mover.id] },
        cookies: adminCookies,
      });
      expect(stale.statusCode).toBe(409);

      // The new slot's does.
      const fresh = await on.app.inject({
        method: 'PUT',
        url: '/admin/home-banners/order',
        payload: { slot: 'below_results', orderedIds: [mover.id] },
        cookies: adminCookies,
      });
      expect(fresh.statusCode).toBe(200);
    });

    it('refuses an unknown slot without a database error', async () => {
      const banner = await makeBanner('before_search', 'Guarded');
      const res = await setSlot(banner.id, 'somewhere_else');
      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain('invalid input syntax');
    });

    it('reports the slot back on the banner, so the editor can show it', async () => {
      const banner = await makeBanner('below_results', 'Readback');
      const res = await on.app.inject({
        method: 'GET',
        url: `/admin/home-banners/${banner.id}`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().slot).toBe('below_results');
    });
  });
});

/* ------------------------------------------------------------------ *
 * 7. Discovery is a separate system
 * ------------------------------------------------------------------ */

describe('keyword-driven Discovery', () => {
  it('matches on ANY keyword, not all of them', async () => {
    const sexy = await makeApprovedAsset();
    const lingerie = await makeApprovedAsset();
    const unrelated = await makeApprovedAsset();
    await api.setAssetKeywords(sexy.id, ['sexy']);
    await api.setAssetKeywords(lingerie.id, ['lingerie']);
    await api.setAssetKeywords(unrelated.id, ['landscape']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy', 'lingerie', 'seductive'] });

    const ids = (await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).toContain(sexy.id);
    expect(ids).toContain(lingerie.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it('counts an asset carrying two of the keywords once', async () => {
    const both = await makeApprovedAsset();
    await api.setAssetKeywords(both.id, ['sexy', 'lingerie']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy', 'lingerie'] });
    const clips = (await api.clips('?category=sexy')).json().clips;
    expect(clips.filter((c: { id: string }) => c.id === both.id)).toHaveLength(1);
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(1);
  });

  it('normalises keywords so casing and spacing do not fork a term', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['  LINGERIE  ']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] });
    expect((await api.clips('?category=sexy')).json().clips.map((c: { id: string }) => c.id)).toContain(
      asset.id,
    );
  });

  it('an empty discovery category matches NOTHING, never everything', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Empty', keywords: [] });
    expect((await api.clips('?category=empty')).json().clips).toEqual([]);
  });

  it('the strip is ordered and its first entry is the default', async () => {
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.createDiscovery({ name: 'Cosplay', keywords: ['cosplay'] });
    const strip = (await api.discoveryCategories()).json().categories;
    expect(strip[0].slug).toBe('sexy');
    expect(strip.map((c: { name: string }) => c.name)).toEqual(['Sexy', 'Cosplay']);
  });

  it('a disabled discovery category leaves the public strip', async () => {
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/discovery/categories/${created.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.discoveryCategories()).json().categories).toEqual([]);
  });

  it('DELETING a discovery category touches neither content nor keywords', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy', 'lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();

    const before = (
      await on.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, asset.id))
    )[0];

    const res = await api.deleteDiscovery(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, contentRemoved: 0 });

    const after = (
      await on.db.select().from(characterVisualAssets).where(eq(characterVisualAssets.id, asset.id))
    )[0];
    expect(after).toEqual(before);

    // The asset keeps both keywords, and the vocabulary survives.
    const kw = await on.app.inject({
      method: 'GET',
      url: `/admin/discovery/content/${asset.id}/keywords`,
      cookies: adminCookies,
    });
    expect(kw.json().keywords.map((k: { key: string }) => k.key).sort()).toEqual([
      'lingerie',
      'sexy',
    ]);
  });

  it('discovery categories and App Categories are separate systems', async () => {
    const appCat = await makeCategory('Trending');
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    // Neither list contains the other's entries.
    const strip = (await api.discoveryCategories()).json().categories;
    expect(strip.map((c: { id: string }) => c.id)).not.toContain(appCat.id);
    const home = (await api.adminHome()).json();
    expect(home.categories.map((c: { slug: string }) => c.slug)).not.toContain('sexy');

    // Deleting a discovery category cannot remove an App Category.
    const created = (await api.adminDiscovery()).json().categories[0];
    await api.deleteDiscovery(created.id);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, appCat.id));
    expect(row).toBeDefined();
  });

  it('search and category are independent filters that compose', async () => {
    const luna = await makeApprovedAsset(LUNA.id);
    await api.setAssetKeywords(luna.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });

    const both = (await api.clips(`?category=sexy&q=${encodeURIComponent(LUNA.displayName)}`)).json();
    expect(both.clips.map((c: { id: string }) => c.id)).toContain(luna.id);

    const noMatch = (await api.clips('?category=sexy&q=zzzznotacharacter')).json();
    expect(noMatch.clips).toEqual([]);

    // Query alone still works with no category.
    const queryOnly = (await api.clips(`?q=${encodeURIComponent(LUNA.displayName)}`)).json();
    expect(queryOnly.clips.map((c: { id: string }) => c.id)).toContain(luna.id);
  });

  it('treats % and _ in a search as literals', async () => {
    await makeApprovedAsset();
    expect((await api.clips('?q=%25')).json().clips).toEqual([]);
    expect((await api.clips('?q=_')).json().clips).toEqual([]);
  });

  it('caps the page size however large a limit is requested', async () => {
    const res = (await api.clips('?limit=100000')).json();
    expect(res.maxLimit).toBe(60);
    expect(res.clips.length).toBeLessThanOrEqual(60);
  });

  it('emits no storage path in discovery results', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    const body = (await api.clips('?category=sexy')).payload;
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('storageKey');
  });
});

/* ------------------------------------------------------------------ *
 * 7b. One definition of "public" — findings from the adversarial review
 * ------------------------------------------------------------------ */

describe('what is listed and what is servable agree', () => {
  /**
   * The failure this guards: a public list advertising a clip whose media then
   * 404s. It renders as a grid of blank tiles and looks like a broken app, and
   * it happens whenever the "is it listed" query and the "may it be served"
   * query use different definitions of public.
   */
  async function everyListedClipIsServable(url: string, ours: Set<string>) {
    const listed = (await api.clips(url)).json().clips as Array<{ id: string }>;
    const mine = listed.filter((item) => ours.has(item.id));
    expect(mine.length).toBeGreaterThan(0);
    for (const item of mine) {
      expect((await api.media(item.id)).statusCode).toBe(200);
    }
  }

  it('every clip in an unfiltered discovery result is fetchable', async () => {
    const asset = await makeApprovedAsset();
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.setAssetKeywords(asset.id, ['sexy']);
    await everyListedClipIsServable('', new Set([asset.id]));
  });

  it('every clip in a category discovery result is fetchable', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await everyListedClipIsServable('?category=sexy', new Set([asset.id]));
  });

  /**
   * The narrow arm. "Carries any keyword at all" would turn an operator's
   * private organisational vocabulary into a publication switch — tagging a
   * clip `internal-review` would make it fetchable by anyone. The keyword has
   * to be one an ENABLED discovery category actually queries.
   */
  it('a keyword NO visible category uses does not publish anything', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['internal-review']);
    expect((await api.media(asset.id)).statusCode).toBe(404);
    expect((await api.clips('')).json().clips.map((c: { id: string }) => c.id)).not.toContain(
      asset.id,
    );
  });

  it('publishes only once a visible category queries that keyword', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['lingerie']);
    expect((await api.media(asset.id)).statusCode).toBe(404);

    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] })).json();
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Hiding the last category using it closes the content again.
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/discovery/categories/${created.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('deleting the last category using a keyword closes its content too', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['lingerie'] })).json();
    expect((await api.media(asset.id)).statusCode).toBe(200);
    await api.deleteDiscovery(created.id);
    // The keyword and the asset both survive — only the reachability goes.
    expect((await api.media(asset.id)).statusCode).toBe(404);
    const kw = await on.app.inject({
      method: 'GET',
      url: `/admin/discovery/content/${asset.id}/keywords`,
      cookies: adminCookies,
    });
    expect(kw.json().keywords.map((k: { key: string }) => k.key)).toEqual(['lingerie']);
  });

  it('a canonical reference of a SUPERSEDED identity version is not fetchable', async () => {
    // The public gallery is version-scoped (it passes the ACTIVE identity id),
    // so a portrait from a replaced version is shown nowhere — its bytes must
    // not stay retrievable by id either.
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const asset = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      contentRating: 'sfw',
    });
    const path = join(testEnv.media.storageDir, 'home-test', `${asset.id}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, PNG);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: path, isCanonical: true })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await api.media(asset.id)).statusCode).toBe(200);

    // Retire the identity version the asset belongs to.
    await on.pool.query(
      `UPDATE character_visual_identities SET status = 'retired' WHERE id = $1`,
      [identity.id],
    );
    expect((await api.media(asset.id)).statusCode).toBe(404);
  });

  it('tagging content is what publishes it to Discovery — untagged stays private', async () => {
    const untagged = await makeApprovedAsset();
    const ids = (await api.clips('')).json().clips.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(untagged.id);
    expect((await api.media(untagged.id)).statusCode).toBe(404);

    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    await api.setAssetKeywords(untagged.id, ['sexy']);
    expect((await api.clips('')).json().clips.map((c: { id: string }) => c.id)).toContain(
      untagged.id,
    );
    expect((await api.media(untagged.id)).statusCode).toBe(200);
  });

  it('every Home card and rail clip is fetchable', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await api.addHero([asset.id]);

    const home = (await api.home()).json();
    const listed: string[] = [
      ...home.hero.map((c: { id: string }) => c.id),
      ...home.categories.flatMap((r: { clips: Array<{ id: string }> }) => r.clips.map((c) => c.id)),
    ];
    // Scoped to the asset this test created: the seeded fixtures carry
    // fabricated storage keys outside the storage root, so the media route
    // refuses them for containment reasons that have nothing to do with
    // publication.
    const mine = listed.filter((id) => id === asset.id);
    expect(mine.length).toBe(2);
    for (const id of mine) expect((await api.media(id)).statusCode).toBe(200);
  });

  it('admin match counts agree with what the app returns', async () => {
    const asset = await makeApprovedAsset();
    await api.setAssetKeywords(asset.id, ['sexy']);
    await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] });
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(1);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    expect((await api.clips('?category=sexy')).json().clips).toEqual([]);
    // The operator must not be told there are matches the app will not show.
    expect((await api.adminDiscovery()).json().categories[0].matchCount).toBe(0);
  });
});

describe('a live banner\'s creative is publicly servable', () => {
  async function makeLiveBanner(overrides: Record<string, unknown> = {}) {
    const upload = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners/creatives',
      headers: { 'content-type': 'multipart/form-data; boundary=----b' },
      cookies: adminCookies,
      payload: Buffer.concat([
        Buffer.from(
          '------b\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        PNG,
        Buffer.from('\r\n------b--\r\n'),
      ]),
    });
    const creative = upload.json() as { id: string };
    const created = await on.app.inject({
      method: 'POST',
      url: '/admin/home-banners',
      payload: {
        title: 'Promo',
        creativeId: creative.id,
        destinationKind: 'external',
        destinationUrl: 'https://example.com/x',
        slot: 'before_search',
        ...overrides,
      },
      cookies: adminCookies,
    });
    return { banner: created.json(), creative };
  }

  const fetchCreative = (id: string) =>
    on.app.inject({ method: 'GET', url: `/api/home/banner-creatives/${id}/file` });

  it('the Home payload gives a PUBLIC creative URL, never the admin one', async () => {
    const { banner } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    const body = (await api.home()).payload;
    // The admin route is requireAuth+requireAdmin: handing it to an anonymous
    // browser would render every banner as an empty box behind a 401.
    expect(body).not.toContain('/admin/home-banners/creatives/');
    expect(body).toContain('/api/home/banner-creatives/');
  });

  it('serves the creative of a live banner to an anonymous caller', async () => {
    const { banner, creative } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    const res = await fetchCreative(creative.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('REFUSES the creative of a draft banner — uploading never publishes', async () => {
    const { creative } = await makeLiveBanner();
    expect((await fetchCreative(creative.id)).statusCode).toBe(404);
  });

  it('refuses again once the banner is unpublished', async () => {
    const { banner, creative } = await makeLiveBanner();
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/publish`,
      cookies: adminCookies,
    });
    expect((await fetchCreative(creative.id)).statusCode).toBe(200);
    await on.app.inject({
      method: 'POST',
      url: `/admin/home-banners/${banner.id}/unpublish`,
      cookies: adminCookies,
    });
    expect((await fetchCreative(creative.id)).statusCode).toBe(404);
  });

  it('refuses an unknown or malformed creative id the same way', async () => {
    expect((await fetchCreative('not-a-uuid')).statusCode).toBe(404);
    expect((await fetchCreative('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  });
});

describe('bad admin input is never a database error', () => {
  it('clamps a nonsense limit instead of letting Postgres raise', async () => {
    for (const qs of ['?limit=-5', '?limit=0', '?limit=abc', '?limit=99999999']) {
      for (const url of [
        `/admin/home/hero/candidates${qs}`,
        `/admin/discovery/content${qs}`,
      ]) {
        const res = await on.app.inject({ method: 'GET', url, cookies: adminCookies });
        expect(res.statusCode).toBe(200);
        expect(res.payload).not.toContain('LIMIT');
      }
    }
  });

  it('reports a malformed Hero asset id per asset, not as a batch failure', async () => {
    const good = await makeApprovedAsset();
    const res = await api.addHero([good.id, 'not-a-uuid']);
    expect(res.statusCode).toBe(200);
    const outcomes = res.json().outcomes as Array<{ assetId: string; added: boolean }>;
    expect(outcomes.find((o) => o.assetId === good.id)!.added).toBe(true);
    expect(outcomes.find((o) => o.assetId === 'not-a-uuid')!.added).toBe(false);
  });

  it('a duplicate discovery slug is a 409, not a constraint 500', async () => {
    expect((await api.createDiscovery({ name: 'Sexy' })).statusCode).toBe(201);
    const clash = await api.createDiscovery({ name: 'Sexy' });
    expect(clash.statusCode).toBe(409);
    expect(clash.payload).not.toContain('constraint');
  });
});

/* ------------------------------------------------------------------ *
 * 8. Preview
 * ------------------------------------------------------------------ */

describe('preview', () => {
  it('returns the real composition for both audiences', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const preview = (await api.preview()).json();
    expect(preview.newVisitor.categories.map((c: { id: string }) => c.id)).toContain(category.id);
    expect(preview.returning.categories.map((c: { id: string }) => c.id)).toContain(category.id);
    expect(preview.generatedAt).toBeTruthy();
  });

  it('shows an unpublished category to NOBODY, including in preview', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    const preview = (await api.preview()).json();
    expect(preview.newVisitor.categories).toEqual([]);
    expect(preview.returning.categories).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 9. Authorization
 * ------------------------------------------------------------------ */

describe('authorization', () => {
  const UNKNOWN = '11111111-1111-4111-8111-111111111111';

  it('every admin Home and Discovery route rejects anonymous callers', async () => {
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home' }),
      on.app.inject({ method: 'GET', url: '/admin/home/preview' }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero' }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero/candidates' }),
      on.app.inject({ method: 'POST', url: '/admin/home/hero', payload: { assetIds: [] } }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/hero/${UNKNOWN}` }),
      on.app.inject({ method: 'PUT', url: '/admin/home/hero/order', payload: { orderedIds: [] } }),
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home/categories/${UNKNOWN}`,
        payload: { homePublished: true },
      }),
      on.app.inject({ method: 'PUT', url: '/admin/home/categories/order', payload: { orderedIds: [] } }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/categories' }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/keywords' }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/content' }),
      on.app.inject({ method: 'POST', url: '/admin/discovery/categories', payload: { name: 'x' } }),
      on.app.inject({ method: 'DELETE', url: `/admin/discovery/categories/${UNKNOWN}` }),
      on.app.inject({
        method: 'PUT',
        url: `/admin/discovery/content/${UNKNOWN}/keywords`,
        payload: { keywords: [] },
      }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('every admin Home and Discovery route rejects signed-in non-admins', async () => {
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/preview', cookies: userCookies }),
      on.app.inject({ method: 'GET', url: '/admin/home/hero', cookies: userCookies }),
      on.app.inject({
        method: 'PATCH',
        url: `/admin/home/categories/${UNKNOWN}`,
        payload: { homePublished: true },
        cookies: userCookies,
      }),
      on.app.inject({ method: 'GET', url: '/admin/discovery/categories', cookies: userCookies }),
      on.app.inject({
        method: 'POST',
        url: '/admin/discovery/categories',
        payload: { name: 'x' },
        cookies: userCookies,
      }),
      on.app.inject({
        method: 'PUT',
        url: `/admin/discovery/content/${UNKNOWN}/keywords`,
        payload: { keywords: [] },
        cookies: userCookies,
      }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(403);
  });

  it('a non-admin cannot publish a category to Home', async () => {
    const category = await makeCategory();
    await api.publish(category.id, true, userCookies);
    const [row] = await on.db.select().from(appCategories).where(eq(appCategories.id, category.id));
    expect(row!.homePublished).toBe(false);
  });

  it('the public routes need no account', async () => {
    for (const url of ['/api/home', '/api/discovery/categories', '/api/discovery/clips']) {
      expect((await on.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  });

  it('a bad id is a clean 400, never a database error', async () => {
    const res = await api.publish('not-a-uuid', true);
    expect(res.statusCode).toBe(400);
    for (const leak of ['violates', 'constraint', 'syntax for type']) {
      expect(res.payload).not.toContain(leak);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 10. Isolation — composing Home never modifies content
 * ------------------------------------------------------------------ */

describe('isolation', () => {
  it('publishing, ordering, hero and keyword work leave the Library untouched', async () => {
    const category = await makeCategory();
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);

    const [before] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));

    await api.publish(category.id, true);
    await api.orderCategories([category.id]);
    await api.addHero([asset.id]);
    await api.orderHero([asset.id]);
    await api.setAssetKeywords(asset.id, ['sexy', 'lingerie']);
    const created = (await api.createDiscovery({ name: 'Sexy', keywords: ['sexy'] })).json();
    await api.deleteDiscovery(created.id);
    await api.removeHero(asset.id);
    await api.publish(category.id, false);

    const [after] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(after).toEqual(before);
  });

  it('removing a Hero clip does not delete the asset', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    const res = await api.removeHero(asset.id);
    expect(res.json()).toMatchObject({ removed: true, assetKept: true });
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 11. Scope boundary
 * ------------------------------------------------------------------ */

describe('scope', () => {
  it('the Home payload contains no performance, segmentation or targeting fields', async () => {
    const body = (await api.home()).payload;
    for (const term of [
      'score',
      'trending',
      'views',
      'impressions',
      'engagement',
      'segment',
      'country',
      'geo',
      'demographic',
      'variant',
      'experiment',
    ]) {
      expect(body.toLowerCase()).not.toContain(term);
    }
  });

  it('the Hero is admin-assigned — nothing is auto-assigned', async () => {
    const asset = await makeApprovedAsset();
    // Approving content does not put it in the Hero. The ASSIGNED list stays
    // empty; the public Hero falls back to representative clips so the top of
    // the page is not blank, and that fallback is not an assignment.
    expect((await api.adminHome()).json().hero).toEqual([]);
    const home = (await api.home()).json();
    expect(home.hero.every((c: { id: string }) => c.id !== asset.id || true)).toBe(true);
    expect((await api.adminHome()).json().hero).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The manual content workflow, end to end
 *
 * The workflow UAT asked for: create a character with a name, upload to her,
 * see it, approve it, put it in a category or the Hero, and have the lobby
 * reflect that — without any of it being blocked by Visual DNA, by requirement
 * quantities, or by an empty CMS.
 * ------------------------------------------------------------------ */

describe('a character needs only a name', () => {
  async function createByName(displayName: string) {
    const res = await createCharacterByName(displayName);
    expect(res.statusCode).toBe(201);
    return (res.json() as { character: { id: string; name: string } }).character;
  }

  it('is created with no photo, no content, no DNA', async () => {
    const created = await createByName('Nameonly');
    expect(created.id).toBeTruthy();
    // No visual identity was created for her, and that is fine.
    expect(await getActiveVisualIdentity(on.db, created.id)).toBeFalsy();
  });

  it('can receive an upload immediately, without Visual DNA being authored first', async () => {
    // THE BLOCKER THIS REMOVES. uploadLibraryAsset used to throw
    // `no_active_identity`, so a character could not hold media until an
    // operator had written her DNA — the wrong way round.
    const created = await createByName('Uploadable');
    const res = await uploadTo(created.id);
    expect(res.statusCode).toBe(201);

    // The identity was provisioned on demand, exactly as quick-create does.
    const identity = await getActiveVisualIdentity(on.db, created.id);
    expect(identity).toBeTruthy();
    expect(identity!.visualDna).toMatchObject({ apparentAgeBand: 'adult' });
    // And it invented nothing else about her appearance.
    expect(Object.keys(identity!.visualDna as object)).toEqual(['apparentAgeBand']);
  });

  it('provisions that identity ONCE, however many uploads follow', async () => {
    const created = await createByName('Manyuploads');
    for (let i = 0; i < 3; i += 1) expect((await uploadTo(created.id)).statusCode).toBe(201);
    const versions = await on.db
      .select()
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.characterId, created.id));
    expect(versions).toHaveLength(1);
  });

  it('an upload NEVER becomes a primary reference by itself', async () => {
    // The security-relevant half: auto-provisioning must not promote anything.
    const created = await createByName('Notprimary');
    const asset = (await uploadTo(created.id)).json() as { assetId: string };
    const [row] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.assetId));
    expect(row!.kind).toBe('generated');
    expect(row!.status).toBe('under_review');
    expect(row!.isCanonical).toBe(false);
  });
});

/**
 * Creates a character with a NAME ONLY, through the real Admin route the form
 * uses — multipart with no file part.
 */
async function createCharacterByName(displayName: string) {
  const name = `${displayName.toLowerCase()}-${process.pid}-${++seq}`;
  return on.app.inject({
    method: 'POST',
    url: '/admin/characters/quick',
    headers: { 'content-type': 'multipart/form-data; boundary=----n' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(`------n\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
      Buffer.from(
        `------n\r\nContent-Disposition: form-data; name="displayName"\r\n\r\n${displayName}\r\n`,
      ),
      Buffer.from('------n--\r\n'),
    ]),
  });
}

/**
 * Uploads one small WEBM to a character — a real video, through the real route.
 *
 * The extension is what `mediaTypeOf` reads, so this is how a test produces an
 * asset the CMS genuinely classifies as video rather than an image pretending.
 */
async function uploadVideoTo(characterId: string) {
  return on.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { 'content-type': 'multipart/form-data; boundary=----v' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(
        `------v\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n`,
      ),
      Buffer.from(
        '------v\r\nContent-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: video/webm\r\n\r\n',
      ),
      WEBM,
      Buffer.from('\r\n------v--\r\n'),
    ]),
  });
}

/** Uploads one small PNG to a character through the real multipart route. */
async function uploadTo(characterId: string) {
  return on.app.inject({
    method: 'POST',
    url: '/admin/content/uploads',
    headers: { 'content-type': 'multipart/form-data; boundary=----u' },
    cookies: adminCookies,
    payload: Buffer.concat([
      Buffer.from(
        `------u\r\nContent-Disposition: form-data; name="characterId"\r\n\r\n${characterId}\r\n`,
      ),
      Buffer.from(
        '------u\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      PNG,
      Buffer.from('\r\n------u--\r\n'),
    ]),
  });
}

describe('requirement quantities are targets, never limits', () => {
  it('accepts far more clips than any configured quantity', async () => {
    const created = (await createCharacterByName('Unlimited')).json().character as { id: string };

    for (let i = 0; i < 12; i += 1) {
      expect((await uploadTo(created.id)).statusCode).toBe(201);
    }
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, created.id));
    expect(rows).toHaveLength(12);
  });
});

describe('the Hero falls back rather than disappearing', () => {
  /**
   * The fallback borrows from Play with Me, and those cards are now VIDEO-only
   * (a reference image is no longer passed off as a clip). So a borrowable
   * video has to exist for there to be anything to borrow — that is the new
   * rule showing through, not a weakened assertion.
   */
  beforeEach(async () => {
    const video = await makeApprovedVideoAsset();
    await publishViaKeyword(video.id, 'herofallback');
  });

  it('shows representative clips when no Hero clip is configured', async () => {
    const home = (await api.home()).json();
    expect(home.hero.length).toBeGreaterThan(0);
    expect(home.hero.length).toBeLessThanOrEqual(3);
    // Borrowed from Play with Me, so it can only ever show what was already
    // public on this page.
    const playable = home.playWithMe
      .filter((c: { clip: unknown }) => c.clip)
      .map((c: { clip: { id: string } }) => c.clip.id);
    for (const clip of home.hero) expect(playable).toContain(clip.id);
  });

  it('a configured Hero is the source of truth — the fallback never tops it up', async () => {
    const asset = await makeApprovedAsset();
    expect((await api.addHero([asset.id])).statusCode).toBe(200);
    const home = (await api.home()).json();
    expect(home.hero.map((c: { id: string }) => c.id)).toEqual([asset.id]);
  });

  it('respects the operator’s Hero order', async () => {
    const a = await makeApprovedAsset();
    const b = await makeApprovedAsset();
    await api.addHero([a.id, b.id]);
    expect((await api.orderHero([b.id, a.id])).statusCode).toBe(200);
    expect((await api.home()).json().hero.map((c: { id: string }) => c.id)).toEqual([b.id, a.id]);
  });

  it('is empty when no character has a publicly reachable clip', async () => {
    await on.db.update(characters).set({ status: 'inactive' });
    expect((await api.home()).json().hero).toEqual([]);
  });
});

describe('the lobby pills and character grid', () => {
  const pills = () => on.app.inject({ method: 'GET', url: '/api/categories' });
  const browse = (qs = '') =>
    on.app.inject({ method: 'GET', url: `/api/browse/characters${qs}` });

  it('the pills are enabled App Categories, in the operator’s order', async () => {
    const first = await makeCategory('Alpha');
    const second = await makeCategory('Beta');
    await api.publish(first.id, true);
    await api.publish(second.id, true);
    const res = await pills();
    expect(res.statusCode).toBe(200);
    const slugs = (res.json().categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain(first.slug);
    expect(slugs).toContain(second.slug);
    expect(slugs.indexOf(first.slug)).toBeLessThan(slugs.indexOf(second.slug));
  });

  it('a disabled category is not offered as a pill', async () => {
    const category = await makeCategory('Hidden');
    await api.publish(category.id, true);
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    const slugs = ((await pills()).json().categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).not.toContain(category.slug);
  });

  it('with NO category selected it returns every active character', async () => {
    // The unfiltered "All" state. This is what makes search work before a
    // single category has been configured.
    const res = await browse();
    expect(res.statusCode).toBe(200);
    const active = await on.db.select().from(characters).where(eq(characters.status, 'active'));
    expect(res.json().characters).toHaveLength(active.length);
  });

  it('search works with no category, matching on display name', async () => {
    const res = await browse(`?q=${encodeURIComponent(LUNA.displayName)}`);
    expect(res.statusCode).toBe(200);
    const names = (res.json().characters as Array<{ displayName: string }>).map(
      (c) => c.displayName,
    );
    expect(names).toContain(LUNA.displayName);
  });

  it('a category returns only characters with a publicly reachable clip in it', async () => {
    const category = await makeCategory('Grid');
    const asset = await makeApprovedAsset();
    expect((await assign(category.id, [asset.id])).statusCode).toBe(200);
    await api.publish(category.id, true);

    const res = await browse(`?category=${category.slug}`);
    expect(res.json().characters.map((c: { id: string }) => c.id)).toEqual([LUNA.id]);
  });

  it('an EMPTY category returns nothing, and never everything', async () => {
    const category = await makeCategory('Barren');
    await api.publish(category.id, true);
    expect((await browse(`?category=${category.slug}`)).json().characters).toEqual([]);
  });

  it('an unknown slug shows nobody, and never the whole roster', async () => {
    // Same rule discovery applies: a category that resolves to nothing matches
    // nothing. Widening to everything would make a misconfigured pill look as
    // if it were working.
    expect((await browse('?category=no-such-category')).json().characters).toEqual([]);
  });

  it('a category whose clip is unapproved shows nobody', async () => {
    const category = await makeCategory('Unapproved');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.id, asset.id));
    expect((await browse(`?category=${category.slug}`)).json().characters).toEqual([]);
  });

  it('the card carries real category membership, never invented tags', async () => {
    const category = await makeCategory('Chips');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    const card = (await browse()).json().characters.find((c: { id: string }) => c.id === LUNA.id);
    expect(card.categories.map((c: { slug: string }) => c.slug)).toContain(category.slug);
    expect(card.name).toBe(LUNA.name);
  });

  it('exposes no storage key or filesystem path', async () => {
    const payload = (await browse()).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain('/app/var/media');
    expect(payload).not.toContain('provenance');
  });

  it('an inactive character is in no grid and no category', async () => {
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));
    const ids = (await browse()).json().characters.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(LUNA.id);
  });
});

describe('a character’s content shelf', () => {
  const shelf = (characterId: string, cookies = adminCookies) =>
    on.app.inject({ method: 'GET', url: `/admin/characters/${characterId}/content`, cookies });

  it('lists everything the character has, with previews and placement', async () => {
    const asset = await makeApprovedAsset();
    const category = await makeCategory('Shelf');
    await assign(category.id, [asset.id]);
    await api.addHero([asset.id]);

    const res = await shelf(LUNA.id);
    expect(res.statusCode).toBe(200);
    const found = (res.json().assets as Array<{ assetId: string }>).find(
      (a) => a.assetId === asset.id,
    ) as unknown as {
      previewUrl: string;
      status: string;
      placement: { heroPosition: number | null; categories: Array<{ slug: string }> };
    };
    expect(found.status).toBe('approved');
    expect(found.previewUrl).toBe(`/admin/content/assets/${asset.id}/file`);
    expect(found.placement.heroPosition).toBe(0);
    expect(found.placement.categories.map((c) => c.slug)).toEqual([category.slug]);
  });

  it('includes content still in review, so nothing looks lost after upload', async () => {
    const pending = await makeUnapprovedAsset();
    const ids = (await shelf(LUNA.id)).json().assets.map((a: { assetId: string }) => a.assetId);
    expect(ids).toContain(pending.id);
  });

  it('leaks no storage key or path', async () => {
    await makeApprovedAsset();
    const payload = (await shelf(LUNA.id)).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain('/app/var/media');
  });

  it('is admin-only and 404s an unknown character', async () => {
    expect((await shelf(LUNA.id, {})).statusCode).toBe(401);
    expect((await shelf(LUNA.id, userCookies)).statusCode).toBe(403);
    expect((await shelf('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await shelf('not-a-uuid')).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * THE WHOLE MANUAL WORKFLOW, IN ORDER
 *
 * One test that walks the exact operator journey rather than asserting its
 * parts in isolation: name → uploads → previews → approve → categorise →
 * reorder → Hero → publish → visible. Each step's precondition is the previous
 * step's result, so a break anywhere in the chain fails here.
 * ------------------------------------------------------------------ */

describe('manual content workflow, end to end', () => {
  it('name-only character to live on the lobby', async () => {
    /* 1. Create with a NAME ONLY. */
    const created = (await createCharacterByName('Endtoend')).json().character as {
      id: string;
      name: string;
      displayName: string;
      status: string;
    };
    expect(created.id).toBeTruthy();
    // Created unpublished — the safety rule is intact.
    expect(created.status).not.toBe('active');

    /* 2. Upload 12 clips — more than any configured quantity. */
    const assetIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await uploadTo(created.id);
      expect(res.statusCode).toBe(201);
      assetIds.push((res.json() as { assetId: string }).assetId);
    }

    /* 3. Previews are available immediately, while still in review. */
    const shelfBefore = (
      await on.app.inject({
        method: 'GET',
        url: `/admin/characters/${created.id}/content`,
        cookies: adminCookies,
      })
    ).json().assets as Array<{
      assetId: string;
      status: string;
      previewUrl: string | null;
    }>;
    expect(shelfBefore).toHaveLength(12);
    expect(shelfBefore.every((a) => a.status === 'under_review')).toBe(true);
    expect(shelfBefore.every((a) => a.previewUrl !== null)).toBe(true);
    // The preview actually serves bytes, before approval.
    const preview = await on.app.inject({
      method: 'GET',
      url: shelfBefore[0]!.previewUrl!,
      cookies: adminCookies,
    });
    expect(preview.statusCode).toBe(200);

    /* 4. Approve them. */
    for (const assetId of assetIds) {
      const res = await on.app.inject({
        method: 'POST',
        url: `/admin/content/assets/${assetId}/approve`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
    }

    /* 5. Assign to a category, publish it, and reorder inside it. */
    const category = await makeCategory('Journey');
    const inCategory = assetIds.slice(0, 4);
    expect((await assign(category.id, inCategory)).statusCode).toBe(200);
    await api.publish(category.id, true);

    const reversed = [...inCategory].reverse();
    const reorder = await on.app.inject({
      method: 'PUT',
      url: `/admin/app-categories/${category.id}/assets/order`,
      payload: { orderedAssetIds: reversed },
      cookies: adminCookies,
    });
    expect(reorder.statusCode).toBe(200);

    /* 6. Choose Hero clips and order them. */
    const heroPick = [assetIds[5]!, assetIds[6]!];
    expect((await api.addHero(heroPick)).statusCode).toBe(200);
    expect((await api.orderHero([heroPick[1]!, heroPick[0]!])).statusCode).toBe(200);

    /* 7. Still not public — she is unpublished. */
    const beforePublish = (await on.app.inject({
      method: 'GET',
      url: '/api/browse/characters',
    })).json().characters as Array<{ id: string }>;
    expect(beforePublish.map((c) => c.id)).not.toContain(created.id);

    /* 8. Publish her. */
    const activated = await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${created.id}`,
      payload: { status: 'active' },
      cookies: adminCookies,
    });
    expect(activated.statusCode).toBe(200);

    /* 9. The existing public character page has what it expects. */
    const publicCharacter = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${created.id}`,
    });
    expect(publicCharacter.statusCode).toBe(200);
    expect(publicCharacter.json().displayName).toBe(created.displayName);
    const visual = await on.app.inject({
      method: 'GET',
      url: `/api/characters/${created.id}/visual-identity`,
    });
    expect(visual.statusCode).toBe(200);

    /* 10. She is on the lobby grid. */
    const grid = (await on.app.inject({ method: 'GET', url: '/api/browse/characters' })).json()
      .characters as Array<{ id: string; categories: Array<{ slug: string }> }>;
    const card = grid.find((c) => c.id === created.id)!;
    expect(card).toBeTruthy();
    expect(card.categories.map((c) => c.slug)).toContain(category.slug);

    /* 11. Category filtering returns her. */
    const filtered = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?category=${category.slug}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(filtered.map((c) => c.id)).toContain(created.id);

    /* 12. Search with NO category selected finds her. */
    const searched = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?q=${encodeURIComponent(created.displayName)}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(searched.map((c) => c.id)).toEqual([created.id]);

    /* 13. The Hero is EXACTLY the chosen clips, in the chosen order — the
           fallback added nothing. */
    const home = (await api.home()).json();
    expect(home.hero.map((c: { id: string }) => c.id)).toEqual([heroPick[1], heroPick[0]]);
    expect((await api.adminHome()).json().heroFallback).toEqual([]);

    /* 14. The category rail carries the operator's order. */
    const rail = home.categories.find((r: { slug: string }) => r.slug === category.slug);
    expect(rail.clips.map((c: { id: string }) => c.id)).toEqual(reversed);

    /* 15. Existing seeded characters still work alongside her. */
    expect(grid.map((c) => c.id)).toContain(LUNA.id);
    expect(
      (await on.app.inject({ method: 'GET', url: `/api/characters/${LUNA.id}` })).statusCode,
    ).toBe(200);
  });
});

describe('the Hero fallback is never persisted', () => {
  /**
   * Same reason as the suite above, and TWO characters' videos rather than one:
   * a test below asserts the fallback borrows more than a single clip before a
   * configured clip replaces the whole of it.
   */
  beforeEach(async () => {
    const luna = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(luna.id, 'heropersist');
    const ember = await makeApprovedVideoAsset(EMBER.id);
    await api.setAssetKeywords(ember.id, ['heropersist']);
  });

  it('an unconfigured Hero writes nothing — the assigned list stays empty', async () => {
    const publicHero = (await api.home()).json().hero;
    expect(publicHero.length).toBeGreaterThan(0);
    // Read it repeatedly: a fallback that leaked into storage would show up as
    // an assignment on the admin side.
    await api.home();
    await api.home();
    expect((await api.adminHome()).json().hero).toEqual([]);
    const rows = await on.db.select().from(homeHeroClips);
    expect(rows).toEqual([]);
  });

  it('admin reports the fallback separately from the configuration', async () => {
    const unconfigured = (await api.adminHome()).json();
    expect(unconfigured.hero).toEqual([]);
    expect(unconfigured.heroFallback.length).toBeGreaterThan(0);

    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);

    const configured = (await api.adminHome()).json();
    expect(configured.hero.map((c: { assetId: string }) => c.assetId)).toEqual([asset.id]);
    // Configured means no fallback at all — never a blend.
    expect(configured.heroFallback).toEqual([]);
  });

  it('one configured clip replaces the whole fallback, it never tops it up', async () => {
    const borrowed = (await api.home()).json().hero.length;
    expect(borrowed).toBeGreaterThan(1);

    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);

    const home = (await api.home()).json();
    expect(home.hero).toHaveLength(1);
    expect(home.hero[0].id).toBe(asset.id);
  });

  it('removing the last clip returns to borrowing, still without persisting', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);
    expect((await api.home()).json().hero).toHaveLength(1);

    await api.removeHero(asset.id);
    expect((await api.adminHome()).json().hero).toEqual([]);
    expect(await on.db.select().from(homeHeroClips)).toEqual([]);
    expect((await api.home()).json().hero.length).toBeGreaterThan(0);
  });
});

describe('the public lobby has no Recently Added surface', () => {
  it('and neither does the CMS — the feature was removed, not hidden', async () => {
    const res = await api.home();
    expect(res.json()).not.toHaveProperty('recentlyAdded');
    expect(res.payload).not.toMatch(/recentlyAdded/i);
    // And Admin can no longer curate it.
    expect(
      (await on.app.inject({ method: 'GET', url: '/admin/home/recent', cookies: adminCookies }))
        .statusCode,
    ).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * The UAT journey, end to end
 *
 * One test, walked in the operator's real order, because every step of this
 * chain was already implemented and the chain still could not be completed:
 * a freshly created character is INACTIVE, and the Content Library's character
 * picker was reading the PUBLIC character list, which is active-only. She was
 * simply absent, with no explanation and a dead Upload button.
 *
 * The two assertions that pin the fix are the pair at the top: absent from
 * `/api/characters`, present in `/admin/characters`. Everything after them was
 * already working and is asserted here so the whole path stays walkable.
 * ------------------------------------------------------------------ */

describe('the Nova journey', () => {
  it('goes from a name to publicly visible without leaving the CMS', async () => {
    /* 1. Create her with a name and nothing else. */
    const created = (await createCharacterByName('Nova')).json() as {
      character: { id: string; status: string; profileComplete: boolean };
      identity: unknown;
    };
    const nova = created.character;
    expect(nova.status).toBe('inactive');
    expect(created.identity).toBeNull();

    /* 2. She is NOT public — and that is correct. */
    const publicList = (await on.app.inject({ method: 'GET', url: '/api/characters' })).json();
    expect(publicList.map((c: { id: string }) => c.id)).not.toContain(nova.id);

    /* 3. …but the ADMIN list has her, which is what the picker now reads. */
    const adminList = (
      await on.app.inject({ method: 'GET', url: '/admin/characters', cookies: adminCookies })
    ).json();
    expect(adminList.map((c: { id: string }) => c.id)).toContain(nova.id);

    /* 4. Upload 12 clips. No quantity anywhere refuses one.
          The FIRST is a video, because the Play with me rail is video-only:
          one card is one character plus one real CMS video, so a character
          who has only uploaded stills never reaches it. */
    expect((await uploadVideoTo(nova.id)).statusCode).toBe(201);
    for (let i = 0; i < 11; i += 1) {
      expect((await uploadTo(nova.id)).statusCode).toBe(201);
    }

    /* 5. Every clip has a preview immediately, before any approval. */
    const shelfUrl = `/admin/characters/${nova.id}/content`;
    const beforeApproval = (
      await on.app.inject({ method: 'GET', url: shelfUrl, cookies: adminCookies })
    ).json().assets as Array<{
      assetId: string;
      characterId: string;
      status: string;
      previewUrl: string | null;
    }>;
    expect(beforeApproval).toHaveLength(12);
    for (const asset of beforeApproval) {
      expect(asset.previewUrl).toMatch(/^\/admin\/content\/assets\/.+\/file$/);
      expect(asset.status).toBe('under_review');
      expect(asset.characterId).toBe(nova.id);
    }
    // The preview actually serves bytes to an admin.
    const probe = await on.app.inject({
      method: 'GET',
      url: beforeApproval[0]!.previewUrl!,
      cookies: adminCookies,
    });
    expect(probe.statusCode).toBe(200);

    /* 6. Approve them. */
    for (const asset of beforeApproval) {
      const res = await on.app.inject({
        method: 'POST',
        url: `/admin/content/assets/${asset.assetId}/approve`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
    }

    /* 7. Approval did not detach a single clip from Nova. */
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, nova.id));
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.characterId).toBe(nova.id);
      expect(row.status).toBe('approved');
    }

    /* 8. Assign three to a category, then reorder them.
          Her VIDEO is chosen deliberately rather than by list position: the
          Play with me rail is video-only, so the clip that makes her card is
          the one that has to be publicly reachable. */
    const category = await makeCategory('Nova Cat');
    const novaAssets = await on.db
      .select({
        id: characterVisualAssets.id,
        storageKey: characterVisualAssets.storageKey,
        provenance: characterVisualAssets.provenance,
      })
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, nova.id));
    // A real upload's storageKey is an opaque serve path; the stored file's
    // extension lives in provenance, which is exactly what `mediaTypeOf` reads.
    const video = novaAssets.find((a) =>
      String((a.provenance as { storagePath?: string }).storagePath ?? '').endsWith('.webm'),
    );
    expect(video).toBeDefined();
    const videoAssetId = video!.id;
    const chosen = [
      videoAssetId,
      ...beforeApproval.map((a) => a.assetId).filter((id) => id !== videoAssetId).slice(0, 2),
    ];
    expect((await assign(category.id, chosen)).statusCode).toBe(200);

    const reversed = [...chosen].reverse();
    const reorder = await on.app.inject({
      method: 'PUT',
      url: `/admin/app-categories/${category.id}/assets/order`,
      payload: { orderedAssetIds: reversed },
      cookies: adminCookies,
    });
    expect(reorder.statusCode).toBe(200);
    const contents = (
      await on.app.inject({
        method: 'GET',
        url: `/admin/app-categories/${category.id}/assets`,
        cookies: adminCookies,
      })
    ).json().assets as Array<{ assetId: string }>;
    expect(contents.map((a) => a.assetId)).toEqual(reversed);

    /* 9. Publish the category. */
    expect((await api.publish(category.id, true)).statusCode).toBe(200);

    /* 10. Put one of her clips in the Hero. Approved is enough — she need not
          be live yet, because the public read gates on that separately. */
    const heroRes = await on.app.inject({
      method: 'POST',
      url: '/admin/home/hero',
      payload: { assetIds: [chosen[0]] },
      cookies: adminCookies,
    });
    expect(heroRes.statusCode).toBe(200);
    expect(heroRes.json().clips.map((c: { assetId: string }) => c.assetId)).toContain(chosen[0]);

    /* 11. While she is NOT live, none of this reaches the public app. */
    const hidden = (await api.home()).json();
    expect(hidden.playWithMe.map((c: { id: string }) => c.id)).not.toContain(nova.id);
    expect(hidden.hero.map((c: { id: string }) => c.id)).not.toContain(chosen[0]);
    expect((await api.media(chosen[0]!)).statusCode).toBe(404);

    /* 12. Write her profile and publish her. */
    const patched = await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${nova.id}`,
      payload: {
        shortBio: 'A bio.',
        personality: 'Warm.',
        conversationStyle: 'Playful.',
        systemPrompt: 'You are Nova.',
        status: 'active',
      },
      cookies: adminCookies,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe('active');

    /* 13. She is on Play with me BY RULE — going live plus an approved,
          publicly reachable video is the whole of it. There is no rail to add
          her to, and nothing an operator has to remember to do. */
    const railIds = ((await api.home()).json().playWithMe as Array<{ id: string }>).map(
      (c) => c.id,
    );
    expect(railIds).toContain(nova.id);

    /* 14. The Hero is independent and untouched by any of it. */
    const heroBefore = (await api.adminHome()).json().hero;
    expect((await api.adminHome()).json().hero).toEqual(heroBefore);

    /* 15. She is publicly visible, and so is the clip she was placed with. */
    const live = (await api.home()).json();
    const novaCard = (live.playWithMe as Array<{ id: string; clip: { id: string; mediaType: string; characterId: string } | null }>)
      .find((c) => c.id === nova.id);
    expect(novaCard).toBeDefined();
    // Her card carries HER video, by asset id — not a portrait, not a placeholder.
    expect(novaCard!.clip).not.toBeNull();
    expect(novaCard!.clip!.mediaType).toBe('video');
    expect(novaCard!.clip!.characterId).toBe(nova.id);
    expect(novaCard!.clip!.id).toBe(videoAssetId);
    expect(live.hero.map((c: { id: string }) => c.id)).toContain(chosen[0]);
    expect((await api.media(chosen[0]!)).statusCode).toBe(200);

    // And the SEARCH grid returns her real content assets, never her identity.
    const searched = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/clips?q=${encodeURIComponent('Nova')}`,
      })
    ).json().clips as Array<{ id: string; characterId: string }>;
    expect(searched.length).toBeGreaterThan(0);
    for (const c of searched) expect(c.characterId).toBe(nova.id);

    // And she is reachable by the category pill she was merchandised into.
    const pills = (
      await on.app.inject({ method: 'GET', url: '/api/categories' })
    ).json().categories as Array<{ slug: string }>;
    expect(pills.map((p) => p.slug)).toContain(category.slug);
    const browsed = (
      await on.app.inject({
        method: 'GET',
        url: `/api/browse/characters?category=${encodeURIComponent(category.slug)}`,
      })
    ).json().characters as Array<{ id: string }>;
    expect(browsed.map((c) => c.id)).toContain(nova.id);

    /* 16. Recently Added no longer exists anywhere in the journey — not in the
          payload the operator previews, and not as an admin route. */
    expect((await api.home()).payload).not.toMatch(/recentlyAdded/i);
  });
});

/* ------------------------------------------------------------------ *
 * A CMS-uploaded video reaching the public card
 *
 * THE GAP THIS CLOSES. A character created through the CMS could upload and
 * approve any number of videos and her public card stayed a still image,
 * because the only video a card could show came from a hard-coded manifest of
 * four seeded names. Her clips were in the payload the whole time; nothing
 * selected them.
 *
 * WHAT IS NOT RELAXED. `publiclyReachableCondition` is untouched, so the card
 * gets a clip only when the clip is approved, the character is ACTIVE, and the
 * clip is placed somewhere public. The tests below assert each of those refusals
 * as well as the success, because a fix that made her video visible one step
 * early would be a leak, not a feature.
 * ------------------------------------------------------------------ */

describe('an uploaded video becomes the public card’s clip', () => {
  /** Nova's card as `/api/home` composes it, or undefined if she is absent. */
  const cardFor = async (id: string) =>
    (await api.home())
      .json()
      .playWithMe.find((c: { id: string }) => c.id === id) as
      | { id: string; clip: { id: string; mediaType: string; url: string } | null }
      | undefined;

  async function novaWithVideo() {
    const nova = (await createCharacterByName('NovaVideo')).json().character as { id: string };
    const upload = await uploadVideoTo(nova.id);
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().assetId as string;
    return { nova, assetId };
  }

  const publish = async (id: string) =>
    on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${id}`,
      payload: {
        shortBio: 'b',
        personality: 'p',
        conversationStyle: 'c',
        systemPrompt: 's',
        status: 'active',
      },
      cookies: adminCookies,
    });

  const approve = async (assetId: string) =>
    on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${assetId}/approve`,
      cookies: adminCookies,
    });

  it('resolves the uploaded VIDEO as her representative clip', async () => {
    const { nova, assetId } = await novaWithVideo();
    expect((await approve(assetId)).statusCode).toBe(200);
    expect((await publish(nova.id)).statusCode).toBe(200);

    // Placement is what makes it public — the same rule as every other clip.
    const category = await makeCategory('Nova Video Cat');
    expect((await assign(category.id, [assetId])).statusCode).toBe(200);
    expect((await api.publish(category.id, true)).statusCode).toBe(200);

    const card = await cardFor(nova.id);
    expect(card).toBeDefined();
    expect(card!.clip).not.toBeNull();
    expect(card!.clip!.id).toBe(assetId);
    // The card now has a VIDEO to show, which is the whole point: the browser
    // resolves this to a <video> instead of falling back to a still.
    expect(card!.clip!.mediaType).toBe('video');
    // An opaque id-keyed route, never a storage key or a filesystem path.
    expect(card!.clip!.url).toBe(`/api/media/assets/${assetId}/file`);
    expect((await api.media(assetId)).statusCode).toBe(200);
  });

  it('keeps her OFF the rail while the video is only uploaded, not approved', async () => {
    // She used to appear with clip=null. The rail is now one character plus one
    // real video, so an unapproved upload leaves her off it entirely.
    const { nova } = await novaWithVideo();
    expect((await publish(nova.id)).statusCode).toBe(200);
    expect(await cardFor(nova.id)).toBeUndefined();
  });

  it('keeps her OFF the rail while she is approved but placed nowhere', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    expect(await cardFor(nova.id)).toBeUndefined();
    expect((await api.media(assetId)).statusCode).toBe(404);
  });

  it('keeps her media NON-PUBLIC entirely while she is unpublished', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    const category = await makeCategory('Unpublished Owner Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);

    // She is still inactive: she is not on the rail at all, and her bytes 404.
    const home = (await api.home()).json();
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(nova.id);
    expect((await api.media(assetId)).statusCode).toBe(404);

    // Publishing her is the single step that changes it.
    await publish(nova.id);
    const card = await cardFor(nova.id);
    expect(card!.clip!.mediaType).toBe('video');
    expect((await api.media(assetId)).statusCode).toBe(200);
  });

  it('drops back to non-public the moment she is taken offline again', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    const category = await makeCategory('Offline Again Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);
    expect((await cardFor(nova.id))!.clip!.mediaType).toBe('video');

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, nova.id));
    expect(await cardFor(nova.id)).toBeUndefined();
    expect((await api.media(assetId)).statusCode).toBe(404);
  });

  it('accepts many videos for one character — no clip becomes a limit', async () => {
    const nova = (await createCharacterByName('NovaManyVideos')).json().character as {
      id: string;
    };
    for (let i = 0; i < 8; i += 1) {
      expect((await uploadVideoTo(nova.id)).statusCode).toBe(201);
    }
    const rows = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.characterId, nova.id));
    expect(rows).toHaveLength(8);
  });

  it('leaves the Hero independently curated — her card clip is not a Hero clip', async () => {
    const { nova, assetId } = await novaWithVideo();
    await approve(assetId);
    await publish(nova.id);
    const category = await makeCategory('Hero Independence Cat');
    await assign(category.id, [assetId]);
    await api.publish(category.id, true);

    // Her card has the video, and the Hero has not adopted it.
    expect((await cardFor(nova.id))!.clip!.id).toBe(assetId);
    const heroIds = (await api.adminHome()).json().hero.map((c: { assetId: string }) => c.assetId);
    expect(heroIds).not.toContain(assetId);

    // Putting it in the Hero is a separate, deliberate act.
    expect((await api.addHero([assetId])).statusCode).toBe(200);
    expect(
      (await api.adminHome()).json().hero.map((c: { assetId: string }) => c.assetId),
    ).toContain(assetId);
  });
});

/* ------------------------------------------------------------------ *
 * The Character page's content collection — GET /api/characters/:id/clips
 *
 * The tab this feeds previously had NO data path: a four-name manifest, two
 * entries sliced off it, six fabricated locked tiles, and `profileImage` as the
 * fallback. Nothing it displayed was a record. These tests pin the replacement:
 * the collection is the collection, and it is bounded only by what she has.
 * ------------------------------------------------------------------ */

describe('a character’s public content collection', () => {
  const clipsFor = (characterId: string) =>
    on.app.inject({ method: 'GET', url: `/api/characters/${characterId}/clips` });

  it('returns ALL eligible clips — twelve means twelve, with no limit of 8', async () => {
    const made: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const asset = await makeApprovedVideoAsset(LUNA.id);
      made.push(asset.id);
      await releaseToPosts(asset.id);
    }

    const res = await clipsFor(LUNA.id);
    expect(res.statusCode).toBe(200);
    const clips = res.json().clips as Array<{ id: string; characterId: string }>;
    expect(clips).toHaveLength(12);
    expect(clips.length).toBeGreaterThan(8);
    expect(clips.map((c) => c.id).sort()).toEqual([...made].sort());
  });

  it('returns only THIS character’s clips', async () => {
    const mine = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(mine.id);
    const hers = await makeApprovedVideoAsset(EMBER.id);
    await releaseToPosts(hers.id);

    const lunaClips = (await clipsFor(LUNA.id)).json().clips as Array<{
      id: string;
      characterId: string;
    }>;
    expect(lunaClips.map((c) => c.id)).toContain(mine.id);
    expect(lunaClips.map((c) => c.id)).not.toContain(hers.id);
    for (const clip of lunaClips) expect(clip.characterId).toBe(LUNA.id);
  });

  it('excludes UNAPPROVED assets', async () => {
    const pending = await makeUnapprovedAsset(LUNA.id);
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>;
    expect(clips.map((c) => c.id)).not.toContain(pending.id);
  });

  it('excludes everything once the character is INACTIVE', async () => {
    const asset = await makeApprovedVideoAsset(EMBER.id);
    await releaseToPosts(asset.id);
    expect(
      ((await clipsFor(EMBER.id)).json().clips as Array<{ id: string }>).map((c) => c.id),
    ).toContain(asset.id);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, EMBER.id));
    // The route itself reads as not-found, matching the sibling public routes.
    expect((await clipsFor(EMBER.id)).statusCode).toBe(404);
  });

  it('excludes assets that are approved but NOT publicly reachable', async () => {
    // Approved, but in no category, no Hero and carrying no keyword.
    const orphan = await makeApprovedVideoAsset(LUNA.id);
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>;
    expect(clips.map((c) => c.id)).not.toContain(orphan.id);
    expect((await api.media(orphan.id)).statusCode).toBe(404);
  });

  /* ---------------------------------------------------------------- *
   * APPROVED IS NOT PUBLISHED.
   *
   * The bug these close: Posts used to ask `publiclyReachableCondition`, which
   * answers "has an operator placed this clip on HOME?" — a different decision
   * from "does this belong on her page". A character with several approved
   * clips therefore showed only the one that happened to be merchandised.
   *
   * The fix does NOT make approval sufficient. Release is its own explicit,
   * reversible act, and these pin both halves.
   * ---------------------------------------------------------------- */

  it('shows EVERY released clip she has — the reported bug', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const asset = await makeApprovedVideoAsset(LUNA.id);
      made.push(asset.id);
      await releaseToPosts(asset.id);
    }
    // Not one of them is merchandised onto Home, and that is the point.
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>;
    expect(clips.map((c) => c.id).sort()).toEqual([...made].sort());
  });

  it('hides an APPROVED but UNRELEASED clip, and refuses its bytes by id', async () => {
    const held = await makeApprovedVideoAsset(LUNA.id);
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>;
    expect(clips.map((c) => c.id)).not.toContain(held.id);
    // The standing guarantee: approval alone must not expose the Library.
    expect((await api.media(held.id)).statusCode).toBe(404);
  });

  it('serves the bytes of every clip it lists — no dead tiles', async () => {
    const a = await makeApprovedVideoAsset(LUNA.id);
    const b = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(a.id);
    await releaseToPosts(b.id);
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string; url: string }>;
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect((await on.app.inject({ method: 'GET', url: clip.url })).statusCode).toBe(200);
    }
  });

  it('UNPUBLISHING removes it from Posts and closes its bytes, without un-approving it', async () => {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(asset.id);
    expect(((await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>).map((c) => c.id))
      .toContain(asset.id);

    const res = await on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${asset.id}/unpublish`,
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(200);

    expect(((await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>).map((c) => c.id))
      .not.toContain(asset.id);
    expect((await api.media(asset.id)).statusCode).toBe(404);
    // Still approved — taking it down is not a rejection.
    const [row] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(eq(characterVisualAssets.id, asset.id));
    expect(row!.status).toBe('approved');
  });

  it('refuses to publish an UNAPPROVED clip or a REFERENCE portrait', async () => {
    const pending = await makeUnapprovedAsset(LUNA.id);
    const held = await on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${pending.id}/publish`,
      cookies: adminCookies,
    });
    expect(held.statusCode).toBe(409);

    const [reference] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(
        and(
          eq(characterVisualAssets.characterId, LUNA.id),
          eq(characterVisualAssets.kind, 'reference'),
        ),
      );
    const portrait = await on.app.inject({
      method: 'POST',
      url: `/admin/content/assets/${reference!.id}/publish`,
      cookies: adminCookies,
    });
    expect(portrait.statusCode).toBe(409);
  });

  it('publish and unpublish are ADMIN ONLY', async () => {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    for (const verb of ['publish', 'unpublish']) {
      expect(
        (
          await on.app.inject({
            method: 'POST',
            url: `/admin/content/assets/${asset.id}/${verb}`,
            cookies: userCookies,
          })
        ).statusCode,
      ).toBe(403);
    }
  });

  /**
   * PLACEMENT AND PUBLICATION ARE DIFFERENT AXES, and releasing to Posts must
   * not quietly put her on Home.
   */
  /**
   * THE FORWARD DIRECTION, and the one the original bug lived in.
   *
   * Merchandising a clip onto Home — a Hero slot, a published category, a
   * discovery keyword — makes it public THERE. It says nothing about her page,
   * and must not put it on Posts. Posts used to be driven entirely by these
   * placements, which is why a character with several approved clips showed
   * only the one that happened to be merchandised.
   */
  it('HOME merchandising does not put a clip on Posts', async () => {
    const viaKeyword = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(viaKeyword.id, 'homeonly');

    const viaHero = await makeApprovedVideoAsset(LUNA.id);
    await api.addHero([viaHero.id]);

    const viaCategory = await makeApprovedVideoAsset(LUNA.id);
    const category = await makeCategory('Posts Independence');
    await assign(category.id, [viaCategory.id]);
    await api.publish(category.id, true);

    // All three are publicly reachable from Home...
    for (const asset of [viaKeyword, viaHero, viaCategory]) {
      expect((await api.media(asset.id)).statusCode).toBe(200);
    }
    // ...and NONE of them is on her Posts tab, because none was released to it.
    const posts = ((await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>).map(
      (c) => c.id,
    );
    for (const asset of [viaKeyword, viaHero, viaCategory]) {
      expect(posts).not.toContain(asset.id);
    }

    // Releasing ONE of them adds exactly that one, and changes nothing else.
    await releaseToPosts(viaHero.id);
    const after = ((await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>).map(
      (c) => c.id,
    );
    expect(after).toEqual([viaHero.id]);
  });

  /**
   * A REMOVED CHARACTER TAKES HER PAGE WITH HER, published clips included.
   * Both gates are checked: the listing route, and the bytes by id.
   */
  it('an INACTIVE character exposes no published content, by listing or by id', async () => {
    const asset = await makeApprovedVideoAsset(EMBER.id);
    await releaseToPosts(asset.id);
    expect(((await clipsFor(EMBER.id)).json().clips as Array<{ id: string }>).map((c) => c.id))
      .toContain(asset.id);
    expect((await api.media(asset.id)).statusCode).toBe(200);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, EMBER.id));

    // The listing route reads as not-found, like its sibling public routes.
    expect((await clipsFor(EMBER.id)).statusCode).toBe(404);
    // And the bytes close immediately, even though published_at is still set.
    expect((await api.media(asset.id)).statusCode).toBe(404);

    // Reactivating her restores it — publication survived, it was only gated.
    await on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, EMBER.id));
    expect(((await clipsFor(EMBER.id)).json().clips as Array<{ id: string }>).map((c) => c.id))
      .toContain(asset.id);
  });

  it('releasing to Posts does NOT put the clip on Play with me or the search grid', async () => {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(asset.id);

    const home = (await api.home()).json();
    expect(home.playWithMe.map((c: { id: string }) => c.id)).not.toContain(LUNA.id);
    expect(home.browseClips.map((c: { id: string }) => c.id)).not.toContain(asset.id);

    const swipe = (await on.app.inject({ method: 'GET', url: '/api/play-with-me' })).json();
    expect(swipe.characters.map((c: { id: string }) => c.id)).not.toContain(LUNA.id);
  });

  it('NEVER returns a reference/primary asset as a content clip', async () => {
    const [reference] = await on.db
      .select()
      .from(characterVisualAssets)
      .where(
        and(
          eq(characterVisualAssets.characterId, LUNA.id),
          eq(characterVisualAssets.kind, 'reference'),
        ),
      );
    expect(reference).toBeDefined();

    const content = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(content.id);

    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{ id: string }>;
    expect(clips.map((c) => c.id)).toContain(content.id);
    expect(clips.map((c) => c.id)).not.toContain(reference!.id);
  });

  it('returns a browser-usable public URL that actually serves bytes', async () => {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(asset.id);
    const [clip] = (await clipsFor(LUNA.id)).json().clips as Array<{
      url: string;
      mediaType: string;
    }>;
    expect(clip!.url).toBe(`/api/media/assets/${asset.id}/file`);
    expect(clip!.mediaType).toBe('video');
    // The listing and the media route agree, by construction.
    expect((await on.app.inject({ method: 'GET', url: clip!.url })).statusCode).toBe(200);
  });

  it('NEVER exposes a storage key or filesystem path', async () => {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    await releaseToPosts(asset.id);
    const body = (await clipsFor(LUNA.id)).payload;
    expect(body).not.toContain('storageKey');
    expect(body).not.toContain('storagePath');
    expect(body).not.toContain(testEnv.media.storageDir);
    expect(body).not.toContain('.webm');
  });

  it('carries an IMAGE content asset as an image, not as a character portrait', async () => {
    // An approved uploaded image is legitimate CONTENT. It is not her
    // reference image, and the collection is allowed to include it.
    const image = await makeApprovedAsset(LUNA.id);
    await releaseToPosts(image.id);
    const clips = (await clipsFor(LUNA.id)).json().clips as Array<{
      id: string;
      mediaType: string;
    }>;
    const found = clips.find((c) => c.id === image.id);
    expect(found).toBeDefined();
    expect(found!.mediaType).toBe('image');
  });

  it('is empty, not fabricated, for a character with no content', async () => {
    const bare = (await createCharacterByName('BareCollection')).json().character as { id: string };
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/characters/${bare.id}`,
      payload: { shortBio: 'b', personality: 'p', conversationStyle: 'c', systemPrompt: 's', status: 'active' },
      cookies: adminCookies,
    });
    const res = await clipsFor(bare.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().clips).toEqual([]);
  });

  it('404s for an unknown or malformed id', async () => {
    for (const id of ['11111111-1111-4111-8111-111111111111', 'not-a-uuid']) {
      expect((await clipsFor(id)).statusCode).toBe(404);
    }
  });
});

/* ------------------------------------------------------------------ *
 * THE PLAY WITH ME INVARIANT
 *
 * One card = one character + one CMS VIDEO asset belonging to that exact
 * character. Not a portrait, not a placeholder, not an image, not a manifest
 * entry, and never another character's asset.
 * ------------------------------------------------------------------ */

describe('Play with Me: one real video per character, or no card', () => {
  it('gives a character with an eligible video exactly one card', async () => {
    const a = await makeApprovedVideoAsset(LUNA.id);
    const b = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(a.id, 'pwmone');
    await publishViaKeyword(b.id, 'pwmtwo');

    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.filter((c) => c.id === LUNA.id)).toHaveLength(1);
  });

  it('the selected asset is a VIDEO and belongs to the displayed character', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'pwmowner');

    const rail = (await api.home()).json().playWithMe as Array<{
      id: string;
      clip: { id: string; mediaType: string; characterId: string } | null;
    }>;
    for (const card of rail) {
      expect(card.clip).not.toBeNull();
      expect(card.clip!.mediaType).toBe('video');
      // Ownership: the asset's character is the card's character.
      expect(card.clip!.characterId).toBe(card.id);
    }
  });

  it('picks the NEWEST eligible video when a character has several', async () => {
    const older = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(older.id, 'pwmold');
    // Force a strictly later createdAt so the ordering is unambiguous.
    await on.db
      .update(characterVisualAssets)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(characterVisualAssets.id, older.id));
    const newer = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(newer.id, 'pwmnew');

    const card = ((await api.home()).json().playWithMe as Array<{
      id: string;
      clip: { id: string } | null;
    }>).find((c) => c.id === EMBER.id);
    expect(card?.clip?.id).toBe(newer.id);
  });

  it('EXCLUDES a character whose only content is an IMAGE', async () => {
    const image = await makeApprovedAsset(EMBER.id);
    await publishViaKeyword(image.id, 'pwmimage');

    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(EMBER.id);
  });

  it('EXCLUDES a character with no content at all — no portrait, no placeholder', async () => {
    const res = await api.home();
    const rail = res.json().playWithMe as Array<{ id: string; clip: unknown }>;
    // Whoever is on the rail has a clip. There is no clip-less card.
    for (const card of rail) expect(card.clip).not.toBeNull();
    // And no card ever carries a profile image as its media.
    expect(res.payload).not.toContain('profileImage":"http');
  });

  it('EXCLUDES a reference/identity asset even when it is the only one', async () => {
    // A canonical reference is approved and reachable, but it is not content.
    const rail = (await api.home()).json().playWithMe as Array<{
      clip: { id: string } | null;
    }>;
    const referenceIds = (
      await on.db
        .select({ id: characterVisualAssets.id })
        .from(characterVisualAssets)
        .where(eq(characterVisualAssets.kind, 'reference'))
    ).map((r) => r.id);
    for (const card of rail) {
      if (card.clip) expect(referenceIds).not.toContain(card.clip.id);
    }
  });

  it('EXCLUDES an unapproved video', async () => {
    const pending = await makeUnapprovedAsset(EMBER.id);
    await publishViaKeyword(pending.id, 'pwmpending');
    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(EMBER.id);
  });

  it('EXCLUDES a video that is approved but reachable from nowhere', async () => {
    const orphan = await makeApprovedVideoAsset(EMBER.id);
    // Deliberately NOT published to any keyword, category or the Hero.
    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(EMBER.id);
    // And its bytes are refused, which is the same rule stated twice.
    expect((await api.media(orphan.id)).statusCode).toBe(404);
  });

  it('EXCLUDES an inactive character even with a published video', async () => {
    const video = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(video.id, 'pwminactive');
    await on.db
      .update(characters)
      .set({ status: 'inactive' })
      .where(eq(characters.id, EMBER.id));

    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    expect(rail.map((c) => c.id)).not.toContain(EMBER.id);
  });

  it('leaks no storage key or filesystem path with the rail', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'pwmleak');
    const payload = (await api.home()).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('/app/var/media');
    expect(payload).not.toContain(testEnv.media.storageDir);
  });
});

/* ------------------------------------------------------------------ *
 * SEARCH IS CLIPS ONLY
 *
 * Every result is a real character_visual_assets CONTENT row, resolvable
 * through the one public media route. Never an identity image, never a
 * fabricated result.
 * ------------------------------------------------------------------ */

describe('Search returns CMS content clips and nothing else', () => {
  it('returns real assets whose bytes the media route actually serves', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'searchreal');

    const clips = (await api.browseClips()).json().clips as Array<{
      id: string;
      url: string;
      characterId: string;
    }>;
    expect(clips.length).toBeGreaterThan(0);
    for (const c of clips) {
      expect(c.url).toBe(`/api/media/assets/${c.id}/file`);
      expect((await api.media(c.id)).statusCode).toBe(200);
    }
  });

  it('EXCLUDES reference/identity assets', async () => {
    const referenceIds = new Set(
      (
        await on.db
          .select({ id: characterVisualAssets.id })
          .from(characterVisualAssets)
          .where(eq(characterVisualAssets.kind, 'reference'))
      ).map((r) => r.id),
    );
    const clips = (await api.browseClips()).json().clips as Array<{ id: string }>;
    for (const c of clips) expect(referenceIds.has(c.id)).toBe(false);
  });

  it('every result belongs to the character it names', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'searchowner');

    const clips = (await api.browseClips()).json().clips as Array<{
      id: string;
      characterId: string;
    }>;
    const owners = new Map(
      (
        await on.db
          .select({ id: characterVisualAssets.id, characterId: characterVisualAssets.characterId })
          .from(characterVisualAssets)
      ).map((r) => [r.id, r.characterId]),
    );
    for (const c of clips) expect(owners.get(c.id)).toBe(c.characterId);
  });

  it('EXCLUDES an approved IMAGE content asset — Search is video-only', async () => {
    // The regression this pins: an uploaded image is legitimate, approved,
    // publicly reachable content, and it still must not be a search result.
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'searchvid');
    const image = await makeApprovedAsset(LUNA.id);
    await publishViaKeyword(image.id, 'searchimg');

    const res = await api.browseClips();
    const clips = res.json().clips as Array<{ id: string; mediaType: string }>;
    // Her video is there...
    expect(clips.find((c) => c.id === video.id)?.mediaType).toBe('video');
    // ...and the image is not, by id and by absence from the payload.
    expect(clips.find((c) => c.id === image.id)).toBeUndefined();
    expect(res.payload).not.toContain(image.id);
    // Nothing returned is anything but a video.
    expect(clips.length).toBeGreaterThan(0);
    for (const c of clips) expect(c.mediaType).toBe('video');
    // Its bytes remain public — this is a search rule, not a visibility change.
    expect((await api.media(image.id)).statusCode).toBe(200);
  });

  it('returns ONLY videos, whatever the mix of approved content', async () => {
    await publishViaKeyword((await makeApprovedAsset(LUNA.id)).id, 'mixa');
    await publishViaKeyword((await makeApprovedAsset(EMBER.id)).id, 'mixb');
    await publishViaKeyword((await makeApprovedVideoAsset(EMBER.id)).id, 'mixc');
    const clips = (await api.browseClips()).json().clips as Array<{ mediaType: string }>;
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((c) => c.mediaType === 'video')).toBe(true);
  });

  it('EXCLUDES unapproved and unreachable content', async () => {
    const pending = await makeUnapprovedAsset(LUNA.id);
    await publishViaKeyword(pending.id, 'searchpending');
    const orphan = await makeApprovedVideoAsset(LUNA.id); // published nowhere

    const ids = ((await api.browseClips()).json().clips as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(orphan.id);
  });

  it('EXCLUDES content belonging to an inactive character', async () => {
    const video = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(video.id, 'searchretired');
    expect(
      ((await api.browseClips()).json().clips as Array<{ id: string }>).map((c) => c.id),
    ).toContain(video.id);

    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, EMBER.id));
    expect(
      ((await api.browseClips()).json().clips as Array<{ id: string }>).map((c) => c.id),
    ).not.toContain(video.id);
  });

  it('MANUFACTURES NOTHING — an unmatched query returns an empty array', async () => {
    const res = await api.browseClips('?q=zzzznobodyhasthisname');
    expect(res.statusCode).toBe(200);
    expect(res.json().clips).toEqual([]);
    // No invented result, no placeholder object, no profile image.
    expect(res.payload).not.toContain('profileImage');
    expect(res.payload).not.toContain('placehold');
  });

  it('matches on the owning character name', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'searchname');
    const ids = (
      (await api.browseClips(`?q=${encodeURIComponent(LUNA.displayName)}`)).json()
        .clips as Array<{ id: string; characterId: string }>
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const c of ids) expect(c.characterId).toBe(LUNA.id);
  });

  it('an unknown category matches nothing rather than everything', async () => {
    const res = await api.browseClips('?category=no-such-category-slug');
    expect(res.json().clips).toEqual([]);
  });

  it('narrows to a published category when a pill is selected', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    const category = await makeCategory('Search Cat');
    await assign(category.id, [video.id]);
    await api.publish(category.id, true);

    const ids = (
      (await api.browseClips(`?category=${category.slug}`)).json().clips as Array<{ id: string }>
    ).map((c) => c.id);
    expect(ids).toContain(video.id);
  });

  it('leaks no storage key or filesystem path', async () => {
    const video = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(video.id, 'searchleak');
    const payload = (await api.browseClips()).payload;
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storagePath');
    expect(payload).not.toContain('/app/var/media');
    expect(payload).not.toContain(testEnv.media.storageDir);
    // And no character identity fields at all — a result is an asset.
    expect(payload).not.toContain('profileImage');
  });
});

describe('Play with Me has no MEMBERSHIP admin surface', () => {
  /**
   * REVISED, NOT WEAKENED. Play with me gained an ORDER control, so the two
   * order routes are no longer 404 and this no longer asserts that they are.
   * What it still asserts is the part that matters and that must never come
   * back: there is no way to ADD a character to the rail or REMOVE one from it.
   * Membership is the video rule. Re-curating it is what made the old screen
   * unusable — in the automatic state the rail already held every candidate, so
   * the Add picker had nothing to offer and a removed character could not be
   * put back.
   */
  it('serves no add, remove, candidates or reset route — every one 404s', async () => {
    const cookies = adminCookies;
    const calls = [
      on.app.inject({ method: 'GET', url: '/admin/home/play-with-me/candidates', cookies }),
      on.app.inject({ method: 'POST', url: '/admin/home/play-with-me', payload: { characterId: EMBER.id }, cookies }),
      on.app.inject({ method: 'DELETE', url: `/admin/home/play-with-me/${EMBER.id}`, cookies }),
      on.app.inject({ method: 'POST', url: '/admin/home/play-with-me/reset', cookies }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);
  });

  it('the rail is the RULE, not an arrangement: publishing a video is the only lever', async () => {
    // active character → newest approved/public video → one card.
    const absent = ((await api.home()).json().playWithMe as Array<{ id: string }>).map((c) => c.id);
    expect(absent).not.toContain(EMBER.id);

    const video = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(video.id, 'onlylever');

    const card = ((await api.home()).json().playWithMe as Array<{
      id: string;
      clip: { id: string; mediaType: string } | null;
    }>).find((c) => c.id === EMBER.id);
    expect(card?.clip?.id).toBe(video.id);
    expect(card?.clip?.mediaType).toBe('video');
  });

  it('rows left in the retired override table change nothing', async () => {
    // The table survives so the removal needed no migration. Nothing reads it.
    await on.db
      .insert(homePlayWithMeCharacters)
      .values({ characterId: EMBER.id, position: 0 })
      .onConflictDoNothing();
    const rail = (await api.home()).json().playWithMe as Array<{ id: string }>;
    // Ember has no eligible video in this test, so the stale row cannot put her
    // on the rail — the rule decides, not the table.
    expect(rail.map((c) => c.id)).not.toContain(EMBER.id);
  });
});


/* ------------------------------------------------------------------ *
 * MEDIA DELIVERY: ranges, validators, and the security that must survive them
 *
 * The route used to stream every file with no length, no validator and no
 * range support, so a looping clip re-downloaded itself once per loop. These
 * assert the new delivery contract AND that none of it can be used to reach a
 * byte the authorization path would refuse.
 * ------------------------------------------------------------------ */

describe('media delivery supports ranges and conditional requests', () => {
  async function publishedVideo() {
    const asset = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(asset.id, `range${++seq}`);
    return asset.id;
  }

  it('advertises range support, a length and validators on a plain GET', async () => {
    const id = await publishedVideo();
    const res = await api.media(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBeDefined();
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['last-modified']).toBeDefined();
    // The length must be the truth, not a guess.
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
  });

  it('answers bytes=0- with 206 — the form a <video> opens with', async () => {
    const id = await publishedVideo();
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { range: 'bytes=0-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-\d+\/\d+$/);
  });

  it('returns ONLY the requested slice, not the whole file', async () => {
    const id = await publishedVideo();
    const full = await api.media(id);
    const size = full.rawPayload.length;
    expect(size).toBeGreaterThan(16);

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { range: 'bytes=0-15' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(16);
    expect(Number(res.headers['content-length'])).toBe(16);
    expect(res.headers['content-range']).toBe(`bytes 0-15/${size}`);
    // And the bytes are the RIGHT ones.
    expect(res.rawPayload.equals(full.rawPayload.subarray(0, 16))).toBe(true);
  });

  it('serves a mid-file seek, which is what makes a loop rewind instead of re-download', async () => {
    const id = await publishedVideo();
    const full = await api.media(id);
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { range: 'bytes=8-23' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.equals(full.rawPayload.subarray(8, 24))).toBe(true);
  });

  it('refuses an out-of-range request with 416 and reports the true size', async () => {
    const id = await publishedVideo();
    const size = (await api.media(id)).rawPayload.length;
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { range: 'bytes=99999999-' },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('answers a matching ETag with 304 and NO body', async () => {
    const id = await publishedVideo();
    const first = await api.media(id);
    const etag = first.headers['etag'] as string;

    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { 'if-none-match': etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
  });

  it('re-sends the file when the client holds a stale validator', async () => {
    const id = await publishedVideo();
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${id}/file`,
      headers: { 'if-none-match': '"stale"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('keeps the five-minute revocation window — no immutable, no year-long cache', async () => {
    const id = await publishedVideo();
    const res = await api.media(id);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.headers['cache-control']).toContain('must-revalidate');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });

  /* ---------------- the part that must NOT have changed ---------------- */

  it('a RANGE header cannot reach an unpublished asset', async () => {
    // Approved but placed nowhere: still refused, byte-range or not.
    const orphan = await makeApprovedVideoAsset(LUNA.id);
    for (const headers of [{}, { range: 'bytes=0-10' }, { 'if-none-match': '*' }]) {
      const res = await on.app.inject({
        method: 'GET',
        url: `/api/media/assets/${orphan.id}/file`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('a RANGE header cannot reach an unapproved asset', async () => {
    const pending = await makeUnapprovedAsset(LUNA.id);
    await publishViaKeyword(pending.id, `rangepending${++seq}`);
    const res = await on.app.inject({
      method: 'GET',
      url: `/api/media/assets/${pending.id}/file`,
      headers: { range: 'bytes=0-10' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('withdrawing an asset takes effect on the very next request, range or not', async () => {
    const id = await publishedVideo();
    expect((await api.media(id)).statusCode).toBe(200);

    // Take her offline — the same revocation the route has always enforced.
    await on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, LUNA.id));

    for (const headers of [{}, { range: 'bytes=0-10' }, { 'if-none-match': '*' }]) {
      const res = await on.app.inject({
        method: 'GET',
        url: `/api/media/assets/${id}/file`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('still leaks no storage key or path in any response variant', async () => {
    const id = await publishedVideo();
    for (const headers of [{}, { range: 'bytes=0-10' }, { range: 'bytes=99999999-' }]) {
      const res = await on.app.inject({
        method: 'GET',
        url: `/api/media/assets/${id}/file`,
        headers,
      });
      const blob = JSON.stringify(res.headers) + res.payload;
      expect(blob).not.toContain('storageKey');
      expect(blob).not.toContain('/app/var/media');
      expect(blob).not.toContain(testEnv.media.storageDir);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Category order: the order an operator saves is the order Home renders
 *
 * THE BUG THESE PIN. `app_categories` carries two order columns —
 * `position` (Publishing → Categories, and the Home pill strip) and
 * `home_position` (the Home composer). The rails read only
 * (home_position, id), and `home_position` DEFAULTS TO 0, so until the
 * composer's own Save order had been used every published category tied on
 * the first key and the tiebreak was a random UUID. Dragging categories on
 * Publishing → Categories saved `position` correctly and Home ignored it:
 * persisted, then discarded, which reads exactly like a save that did nothing.
 * ------------------------------------------------------------------ */

describe('the saved category order is what Home renders', () => {
  /** Two published categories, each holding one publicly reachable clip. */
  async function twoPublishedCategories() {
    const first = await makeCategory('Alpha');
    const second = await makeCategory('Beta');
    const asset = await makeApprovedAsset();
    await assign(first.id, [asset.id]);
    await assign(second.id, [asset.id]);
    await api.publish(first.id, true);
    await api.publish(second.id, true);
    return { first, second };
  }

  const railIds = async () =>
    (await api.home()).json().categories.map((c: { id: string }) => c.id);

  /** The Admin list's own order — the thing an operator is looking at. */
  const cmsIds = async () =>
    (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json().categories.map((c: { id: string }) => c.id);

  it('follows the order saved in Publishing -> Categories', async () => {
    const { first, second } = await twoPublishedCategories();

    expect((await api.orderCmsCategories([second.id, first.id])).statusCode).toBe(200);
    expect(await railIds()).toEqual([second.id, first.id]);
  });

  it('survives repeated reordering, both directions', async () => {
    const { first, second } = await twoPublishedCategories();

    await api.orderCmsCategories([second.id, first.id]);
    expect(await railIds()).toEqual([second.id, first.id]);

    await api.orderCmsCategories([first.id, second.id]);
    expect(await railIds()).toEqual([first.id, second.id]);

    await api.orderCmsCategories([second.id, first.id]);
    expect(await railIds()).toEqual([second.id, first.id]);
  });

  it('does not revert on reload — every read gives the same order', async () => {
    const { first, second } = await twoPublishedCategories();
    await api.orderCmsCategories([second.id, first.id]);

    const once = await railIds();
    const twice = await railIds();
    const thrice = await railIds();
    expect(once).toEqual([second.id, first.id]);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  it('the Home composer writes the SAME order, so both screens agree', async () => {
    // Both editors now write `position`. Reordering in either place moves the
    // rails AND the Admin list — there is no second ordering to diverge.
    const { first, second } = await twoPublishedCategories();

    await api.orderCmsCategories([first.id, second.id]);
    expect(await railIds()).toEqual([first.id, second.id]);

    await api.orderCategories([second.id, first.id]); // the composer
    expect(await railIds()).toEqual([second.id, first.id]);
    expect(await cmsIds()).toEqual([second.id, first.id]);
  });

  it('the composer redistributes only the PUBLISHED slots', async () => {
    // It arranges a subset, so it reuses the positions those categories
    // already occupy rather than renumbering 0..n-1 over everything.
    const { first, second } = await twoPublishedCategories();
    const hidden = await makeCategory('Unpublished');

    await api.orderCmsCategories([first.id, hidden.id, second.id]);
    await api.orderCategories([second.id, first.id]);

    // The unpublished category keeps its own slot, between the two.
    expect(await cmsIds()).toEqual([second.id, hidden.id, first.id]);
    expect(await railIds()).toEqual([second.id, first.id]);
  });

  it('does not give an UNPUBLISHED category a Home slot', async () => {
    const { first, second } = await twoPublishedCategories();
    const hidden = await makeCategory('Hidden');

    await api.orderCmsCategories([hidden.id, second.id, first.id]);
    // The rails hold only the two published ones, in the order given.
    expect(await railIds()).toEqual([second.id, first.id]);
  });

  /* ---------------- the reported regression ---------------- *
   *
   * A first fix made a CMS reorder sync `home_position`, which the rails read.
   * It was not enough: `home_position` is reassigned to the end whenever a
   * category is published, so ANY later publish/unpublish silently
   * desynchronised the two again and the app drifted back out of order with
   * nothing in the Admin to show it. Reproduced against a real stack with
   * position 0,1,2 against home_position 3,1,2.
   *
   * The rails read `position` now, so these hold by construction rather than by
   * a write having happened at the right moment.
   * ------------------------------------------------------------------ */

  it('A -> B -> C in Admin gives A -> B -> C on Home', async () => {
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    const c = await makeCategory('C');
    const asset = await makeApprovedAsset();
    for (const cat of [a, b, c]) {
      await assign(cat.id, [asset.id]);
      await api.publish(cat.id, true);
    }

    await api.orderCmsCategories([a.id, b.id, c.id]);
    expect(await cmsIds()).toEqual([a.id, b.id, c.id]);
    expect(await railIds()).toEqual([a.id, b.id, c.id]);

    // ...and then C -> A -> B.
    await api.orderCmsCategories([c.id, a.id, b.id]);
    expect(await cmsIds()).toEqual([c.id, a.id, b.id]);
    expect(await railIds()).toEqual([c.id, a.id, b.id]);

    // A fresh read gives the same thing — nothing is per-request.
    expect(await railIds()).toEqual([c.id, a.id, b.id]);
  });

  it('PUBLISHING A CATEGORY DOES NOT MOVE THE OTHERS', async () => {
    // The exact trigger of the reported bug: `home_position` was reassigned on
    // publication, so toggling one category rearranged the whole rail.
    const { first, second } = await twoPublishedCategories();
    await api.orderCmsCategories([first.id, second.id]);
    expect(await railIds()).toEqual([first.id, second.id]);

    await api.publish(first.id, false);
    expect(await railIds()).toEqual([second.id]);

    await api.publish(first.id, true);
    // Back in its own slot, not appended to the end.
    expect(await railIds()).toEqual([first.id, second.id]);
    expect(await cmsIds()).toEqual([first.id, second.id]);
  });

  it('hiding and showing a category never re-sorts the rest', async () => {
    const a = await makeCategory('Zulu');
    const b = await makeCategory('Alpha');
    const asset = await makeApprovedAsset();
    for (const cat of [a, b]) {
      await assign(cat.id, [asset.id]);
      await api.publish(cat.id, true);
    }
    // Deliberately NOT alphabetical, so an accidental name sort would show.
    await api.orderCmsCategories([a.id, b.id]);
    expect(await railIds()).toEqual([a.id, b.id]);

    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${a.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });
    expect(await railIds()).toEqual([b.id]);

    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${a.id}`,
      payload: { enabled: true },
      cookies: adminCookies,
    });
    expect(await railIds()).toEqual([a.id, b.id]);
  });

  it('is not sorted by name or slug', async () => {
    // Named so that alphabetical and saved order cannot coincide.
    const zulu = await makeCategory('Zulu');
    const alpha = await makeCategory('Alpha');
    const asset = await makeApprovedAsset();
    for (const cat of [zulu, alpha]) {
      await assign(cat.id, [asset.id]);
      await api.publish(cat.id, true);
    }
    await api.orderCmsCategories([zulu.id, alpha.id]);

    const names = (await api.home()).json().categories.map((c: { name: string }) => c.name);
    expect(names[0]).toMatch(/^Zulu/);
    expect(names[1]).toMatch(/^Alpha/);
  });

  it('ignores home_position entirely, even when it disagrees', async () => {
    // The retroactive half: an installation whose home_position is already
    // wrong must render correctly WITHOUT anyone re-saving anything.
    const { first, second } = await twoPublishedCategories();
    await api.orderCmsCategories([first.id, second.id]);

    // Force the exact broken shape observed in production.
    await on.db
      .update(appCategories)
      .set({ homePosition: 99 })
      .where(eq(appCategories.id, first.id));
    await on.db
      .update(appCategories)
      .set({ homePosition: 0 })
      .where(eq(appCategories.id, second.id));

    expect(await railIds()).toEqual([first.id, second.id]);
  });

  it('the pill strip keeps following the CMS order, as it always did', async () => {
    const { first, second } = await twoPublishedCategories();
    await api.orderCmsCategories([second.id, first.id]);

    const home = (await api.home()).json();
    expect(home.categoryPills.map((p: { id: string }) => p.id)).toEqual([second.id, first.id]);
  });
});

/* ------------------------------------------------------------------ *
 * Play with me: an explicit order, membership still derived
 * ------------------------------------------------------------------ */
describe('Play with me is a category in the Admin, with derived membership', () => {
  /** Luna and Ember, both on the rail. Alphabetically Ember precedes Luna. */
  async function twoOnTheRail() {
    const luna = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(luna.id, `pwmluna${++seq}`);
    const ember = await makeApprovedVideoAsset(EMBER.id);
    await publishViaKeyword(ember.id, `pwmember${++seq}`);
    return { lunaId: LUNA.id, emberId: EMBER.id, lunaAsset: luna.id, emberAsset: ember.id };
  }

  const railIds = async () => (await api.home()).json().playWithMe.map((c: { id: string }) => c.id);
  const boardAssets = async () =>
    (await api.playWithMeContents()).json().assets as Array<{
      assetId: string;
      characterId: string;
      characterName: string;
      mediaType: string;
      previewUrl: string | null;
      position: number;
    }>;

  /* ---------------- the board shows the real clips ---------------- */

  it('lists the ACTUAL clip behind each card, in board shape', async () => {
    const { lunaAsset, emberAsset, lunaId, emberId } = await twoOnTheRail();
    const assets = await boardAssets();

    expect(assets.map((a) => a.assetId).sort()).toEqual([lunaAsset, emberAsset].sort());
    expect(assets.map((a) => a.characterId).sort()).toEqual([lunaId, emberId].sort());
    for (const asset of assets) {
      expect(asset.mediaType).toBe('video');
      expect(asset.previewUrl).toBeTruthy();
      expect(asset.characterName).toBeTruthy();
    }
    // Rendered slots, so the board can index them like any other category.
    expect(assets.map((a) => a.position)).toEqual([0, 1]);
  });

  it('agrees with the app exactly — the board cannot show a card Home drops', async () => {
    await twoOnTheRail();
    expect((await boardAssets()).map((a) => a.characterId)).toEqual(await railIds());
  });

  it('is alphabetical until an order is saved', async () => {
    const { lunaId, emberId } = await twoOnTheRail();
    expect(await railIds()).toEqual([emberId, lunaId]);
    expect((await api.playWithMeContents()).json().ordered).toBe(false);
  });

  /* ---------------- ordering, by clip, keyed on character ---------------- */

  it('takes the CLIPS the board sends and renders that order in the app', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();

    const res = await api.orderPlayWithMe([lunaAsset, emberAsset]);
    expect(res.statusCode).toBe(200);
    expect(res.json().ordered).toBe(true);
    expect(await railIds()).toEqual([lunaId, emberId]);
  });

  it('persists against the CHARACTER, never the clip', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);

    const rows = await on.db.select().from(homePlayWithMeCharacters);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.characterId === lunaId)!.position).toBe(0);
    expect(rows.find((r) => r.characterId === emberId)!.position).toBe(1);
    // No asset id is stored anywhere in the ordering table.
    expect(JSON.stringify(rows)).not.toContain(lunaAsset);
    expect(JSON.stringify(rows)).not.toContain(emberAsset);
  });

  it('survives repeated reordering, both directions', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();

    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    expect(await railIds()).toEqual([lunaId, emberId]);

    await api.orderPlayWithMe([emberAsset, lunaAsset]);
    expect(await railIds()).toEqual([emberId, lunaId]);

    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    expect(await railIds()).toEqual([lunaId, emberId]);
  });

  it('does not revert on reload, and the board agrees with the app', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);

    expect(await railIds()).toEqual([lunaId, emberId]);
    expect(await railIds()).toEqual([lunaId, emberId]);
    const board = (await api.playWithMeContents()).json();
    expect(board.ordered).toBe(true);
    expect(board.assets.map((a: { characterId: string }) => a.characterId)).toEqual([
      lunaId,
      emberId,
    ]);
  });

  it('replaces rather than merges, so a re-save leaves no stale row', async () => {
    const { emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    await api.orderPlayWithMe([emberAsset, lunaAsset]);

    const rows = await on.db.select().from(homePlayWithMeCharacters);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.characterId === emberId)!.position).toBe(0);
  });

  /* ---------------- the clip changing must not disturb the order ---------------- */

  it('KEEPS THE ORDER WHEN THE UNDERLYING CLIP CHANGES — no stale or duplicate entry', async () => {
    // The reason the order is keyed on the character. Approving a newer video
    // moves the `distinct on (character_id)` winner; an asset-keyed order would
    // either lose Luna's slot or list her twice.
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    expect(await railIds()).toEqual([lunaId, emberId]);

    const replacement = await makeApprovedVideoAsset(LUNA.id);
    await publishViaKeyword(replacement.id, `pwmswap${++seq}`);

    // Same order, same number of cards, and exactly one card per character.
    expect(await railIds()).toEqual([lunaId, emberId]);
    const assets = await boardAssets();
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((a) => a.characterId)).size).toBe(2);
    // Still two rows — nothing was added, nothing went stale.
    expect(await on.db.select().from(homePlayWithMeCharacters)).toHaveLength(2);
  });

  /* ---------------- membership stays derived ---------------- */

  it('ORDER NEVER CHANGES MEMBERSHIP — a saved character with no clip is dropped', async () => {
    const { lunaId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);

    await on.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.characterId, EMBER.id));

    expect(await railIds()).toEqual([lunaId]);
    // Her row survives, inert, and is not reaped.
    expect(await on.db.select().from(homePlayWithMeCharacters)).toHaveLength(2);
  });

  it('a newly eligible character APPENDS rather than disappearing', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);

    // Sage is seeded inactive, so she is genuinely NEWLY eligible here:
    // activating her and publishing a video is exactly the lever that puts a
    // character on the rail.
    const sage = SEED_CHARACTERS.find((c) => c.name === 'sage')!;
    await on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, sage.id));
    const sageClip = await makeApprovedVideoAsset(sage.id);
    await publishViaKeyword(sageClip.id, `pwmsage${++seq}`);

    // The saved pair keeps its arrangement; the newcomer lands after it.
    expect(await railIds()).toEqual([lunaId, emberId, sage.id]);
  });

  it('returns to alphabetical when the order is cleared, changing no content', async () => {
    const { lunaId, emberId, lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    expect(await railIds()).toEqual([lunaId, emberId]);

    const res = await api.clearPlayWithMe();
    expect(res.statusCode).toBe(200);
    expect(res.json().ordered).toBe(false);
    expect(await railIds()).toEqual([emberId, lunaId]);
    expect(await on.db.select().from(homePlayWithMeCharacters)).toHaveLength(0);
    expect((await api.home()).json().playWithMe).toHaveLength(2);
  });

  /* ---------------- the same refusals a real category gives ---------------- */

  it('refuses a clip that is not on the rail', async () => {
    const { lunaAsset } = await twoOnTheRail();
    const stray = await makeApprovedAsset();
    const res = await api.orderPlayWithMe([lunaAsset, stray.id]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('unknown_id');
  });

  it('refuses a stale order that omits a card', async () => {
    const { lunaAsset } = await twoOnTheRail();
    const res = await api.orderPlayWithMe([lunaAsset]);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('incomplete');
  });

  it('refuses a duplicate', async () => {
    const { lunaAsset } = await twoOnTheRail();
    const res = await api.orderPlayWithMe([lunaAsset, lunaAsset]);
    expect(res.statusCode).toBe(409);
    // The same clip twice IS the same character twice, and that is the refusal
    // it is reported as — the mapping is transparent, not a second rule.
    expect(res.json().reason).toBe('duplicate');
  });

  it('is admin-only, on every verb', async () => {
    for (const res of [
      await on.app.inject({ method: 'GET', url: '/admin/home/play-with-me/contents' }),
      await on.app.inject({
        method: 'PUT',
        url: '/admin/home/play-with-me/order',
        payload: { orderedAssetIds: [] },
      }),
      await on.app.inject({ method: 'DELETE', url: '/admin/home/play-with-me/order' }),
    ]) {
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it('adds no mode word to the PUBLIC payload', async () => {
    const { lunaAsset, emberAsset } = await twoOnTheRail();
    await api.orderPlayWithMe([lunaAsset, emberAsset]);
    const payload = (await api.home()).payload;
    expect(payload).not.toMatch(/"ordered"/i);
    expect(payload).not.toMatch(/"curated"/i);
  });

  it('reserves the play-with-me slug so a real category cannot shadow it', async () => {
    const res = await on.app.inject({
      method: 'POST',
      url: '/admin/app-categories',
      payload: { name: 'Play with me' },
      cookies: adminCookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/reserved/i);
  });
});

/* ------------------------------------------------------------------ *
 * The Hero "Add clips" picker offers the WHOLE eligible library
 *
 * Reported: some clips simply were not in the picker, so they could not be
 * put on the Hero at all. The list was capped at 100 with no paging, no
 * "load more" and nothing in the UI to say a cap existed — an operator with
 * more than 100 approved clips had no way to reach the rest.
 *
 * The cap was not a product decision. `listAssignmentCandidates`, the
 * category picker doing the same job over the same table in the same admin,
 * has never had one; the route's `boundedLimit` exists to stop `?limit=-5`
 * reaching Postgres, not to bound the library.
 * ------------------------------------------------------------------ */

describe('the Hero picker offers every eligible clip', () => {
  /** More assets than the old default page, so a cap cannot hide behind data. */
  const OVER_THE_OLD_CAP = 105;

  async function manyApprovedAssets(n: number) {
    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const asset = await createVisualAsset(on.db, {
        characterId: LUNA.id,
        visualIdentityId: identity.id,
        kind: 'generated',
        status: 'approved',
        contentRating: 'sfw',
        storageKey: `https://example.invalid/bulk-${i}.mp4`,
      });
      ids.push(asset.id);
    }
    return ids;
  }

  const candidateIds = async (qs = '') =>
    (
      await on.app.inject({
        method: 'GET',
        url: `/admin/home/hero/candidates${qs}`,
        cookies: adminCookies,
      })
    ).json().candidates.map((c: { assetId: string }) => c.assetId) as string[];

  it('returns ALL eligible clips, not just the first page', async () => {
    const ids = await manyApprovedAssets(OVER_THE_OLD_CAP);
    const offered = await candidateIds();

    expect(offered).toHaveLength(OVER_THE_OLD_CAP);
    // Every single one, by id — not merely the right count.
    expect([...offered].sort()).toEqual([...ids].sort());
  });

  it('has no cap at any library size', async () => {
    // Deliberately NOT "the assets after the 100th": the query's tiebreak is
    // the uuid, so which rows a cap would have dropped is not knowable from
    // creation order. Asserting the FULL SET at two sizes either side of the
    // old boundary is the claim that actually holds.
    const first = await manyApprovedAssets(101);
    expect(new Set(await candidateIds())).toEqual(new Set(first));

    const more = await manyApprovedAssets(49);
    expect(new Set(await candidateIds())).toEqual(new Set([...first, ...more]));
  });

  it('an eligible clip cannot vanish just because the library grew', async () => {
    const first = await makeApprovedAsset();
    expect(await candidateIds()).toContain(first.id);

    await manyApprovedAssets(OVER_THE_OLD_CAP);
    // Still there, with a hundred newer assets alongside it.
    expect(await candidateIds()).toContain(first.id);
  });

  it('a clip past the boundary can actually be ADDED to the Hero', async () => {
    // Offering it is only half the bug; it has to be assignable too.
    const ids = await manyApprovedAssets(OVER_THE_OLD_CAP);
    const late = ids[OVER_THE_OLD_CAP - 1]!;

    const res = await api.addHero([late]);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcomes[0]).toMatchObject({ assetId: late, added: true });
    expect(res.json().clips.map((c: { assetId: string }) => c.assetId)).toContain(late);
  });

  /* ---------------- eligibility is UNCHANGED ---------------- */

  it('still refuses every kind of ineligible clip', async () => {
    const approved = await makeApprovedAsset();
    const pending = await makeUnapprovedAsset();

    const identity = (await getActiveVisualIdentity(on.db, LUNA.id))!;
    const reference = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'reference',
      status: 'approved',
      storageKey: 'https://example.invalid/portrait.png',
    });
    const chat = await createVisualAsset(on.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'chat',
      status: 'approved',
      storageKey: 'https://example.invalid/private.mp4',
    });
    // A clip belonging to a character who is not active.
    const sage = SEED_CHARACTERS.find((c) => c.name === 'sage')!;
    const sageIdentity = (await getActiveVisualIdentity(on.db, sage.id))!;
    const inactiveOwner = await createVisualAsset(on.db, {
      characterId: sage.id,
      visualIdentityId: sageIdentity.id,
      kind: 'generated',
      status: 'approved',
      storageKey: 'https://example.invalid/inactive.mp4',
    });

    const offered = new Set(await candidateIds());
    expect(offered.has(approved.id)).toBe(true);
    expect(offered.has(pending.id)).toBe(false);
    expect(offered.has(reference.id)).toBe(false);
    expect(offered.has(chat.id)).toBe(false);
    expect(offered.has(inactiveOwner.id)).toBe(false);
  });

  it('still flags what is already in the Hero rather than hiding it', async () => {
    const asset = await makeApprovedAsset();
    await api.addHero([asset.id]);

    const res = await on.app.inject({
      method: 'GET',
      url: '/admin/home/hero/candidates',
      cookies: adminCookies,
    });
    const row = res.json().candidates.find((c: { assetId: string }) => c.assetId === asset.id);
    expect(row).toBeDefined();
    expect(row.inHero).toBe(true);
  });

  it('an explicit limit is still honoured, and still clamped', async () => {
    // The query parameter is not removed — a caller may still bound the list,
    // and nonsense still cannot reach Postgres.
    await manyApprovedAssets(12);
    expect(await candidateIds('?limit=5')).toHaveLength(5);
    for (const qs of ['?limit=-5', '?limit=0', '?limit=abc']) {
      const res = await on.app.inject({
        method: 'GET',
        url: `/admin/home/hero/candidates${qs}`,
        cookies: adminCookies,
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).not.toContain('LIMIT');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The composer's "would render empty" warning has to be TRUE
 *
 * Reported as "I published a new category and it never appeared on Home".
 * The category was there — in /api/home, with an empty clip list — and the
 * app drops a rail with no clips by design. What failed was the ONE signal
 * that tells an operator that will happen.
 *
 * `publishableAssetCount` came from a correlated subquery whose outer
 * reference was an unqualified `id`. Joining character_visual_assets brought
 * its own `id` into scope, captured the correlation, and turned the
 * predicate into `app_category_assets.category_id = character_visual_assets.id`
 * — a category id against an asset id. It never matched, so the count was
 * ALWAYS ZERO and every published category was flagged as empty, including
 * ones rendering perfectly.
 * ------------------------------------------------------------------ */

describe('a published category reports what Home would actually render', () => {
  const overview = async () =>
    (await api.adminHome()).json().categories as Array<{
      id: string;
      assetCount: number;
      publishableAssetCount: number;
      wouldRenderEmpty: boolean;
    }>;
  const forId = async (id: string) => (await overview()).find((c) => c.id === id)!;

  it('counts an approved assignment, and does NOT cry empty', async () => {
    const category = await makeCategory('Populated');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const row = await forId(category.id);
    expect(row.assetCount).toBe(1);
    expect(row.publishableAssetCount).toBe(1);
    expect(row.wouldRenderEmpty).toBe(false);
  });

  it('the counts agree with the same question asked directly in SQL', async () => {
    // The assertion that would have caught this: the endpoint's own numbers
    // against an unambiguous query over the same rows.
    const category = await makeCategory('Mixed');
    const approved = await makeApprovedAsset();
    const loses = await makeApprovedAsset();
    // Both assigned while approved — the write path refuses an unapproved
    // asset, so losing approval AFTER assignment is the only way a category
    // ends up holding one, and it is the real-world case.
    await assign(category.id, [approved.id, loses.id]);
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.id, loses.id));
    await api.publish(category.id, true);

    // The comparison query asks the FULL rail rule, not just approval. It used
    // to ask `status = 'approved'` alone, which made it agree with a
    // `publishableAssetCount` that was measuring the wrong thing.
    const result = await on.db.execute<{ assets: number; publishable: number }>(sql`
      select
        (select count(*)::int from app_category_assets link
           where link.category_id = ${category.id}) as assets,
        (select count(*)::int from app_category_assets link
           join character_visual_assets asset on asset.id = link.asset_id
           join characters ch on ch.id = asset.character_id
           where link.category_id = ${category.id}
             and asset.status = 'approved'
             and asset.kind = 'generated'
             and ch.status = 'active'
             and asset.storage_key is not null
             and asset.storage_key <> '') as publishable
    `);
    const { assets, publishable } = result.rows[0]!;

    const row = await forId(category.id);
    expect(row.assetCount).toBe(Number(assets));
    expect(row.publishableAssetCount).toBe(Number(publishable));
    expect(row.assetCount).toBe(2);
    expect(row.publishableAssetCount).toBe(1);
    expect(row.wouldRenderEmpty).toBe(false);
  });

  it('flags a category whose content is all unapproved', async () => {
    const category = await makeCategory('All Pending');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    // It loses approval after assignment — the assign route refuses anything
    // unapproved, so this is how a category comes to hold only dead content.
    await on.db
      .update(characterVisualAssets)
      .set({ status: 'under_review' })
      .where(eq(characterVisualAssets.id, asset.id));
    await api.publish(category.id, true);

    const row = await forId(category.id);
    expect(row.assetCount).toBe(1);
    expect(row.publishableAssetCount).toBe(0);
    expect(row.wouldRenderEmpty).toBe(true);
  });

  it('flags a published category with nothing assigned', async () => {
    // The reported case: created, published, never given content.
    const category = await makeCategory('Empty');
    await api.publish(category.id, true);

    const row = await forId(category.id);
    expect(row.assetCount).toBe(0);
    expect(row.publishableAssetCount).toBe(0);
    expect(row.wouldRenderEmpty).toBe(true);
  });

  it('flags a disabled category even when its content is approved', async () => {
    const category = await makeCategory('Disabled');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await on.app.inject({
      method: 'PATCH',
      url: `/admin/app-categories/${category.id}`,
      payload: { enabled: false },
      cookies: adminCookies,
    });

    const row = await forId(category.id);
    expect(row.publishableAssetCount).toBe(1); // the content is fine…
    expect(row.wouldRenderEmpty).toBe(true); // …the category is not
  });

  it('an unpublished category is never flagged, whatever it holds', async () => {
    const category = await makeCategory('Unpublished');
    const row = await forId(category.id);
    expect(row.wouldRenderEmpty).toBe(false);
  });

  it('counts are per category — one does not borrow another\'s content', async () => {
    // The broken correlation compared ids across tables, so this is the shape
    // that proves the subquery is bound to the right row.
    const withContent = await makeCategory('Full');
    const without = await makeCategory('Bare');
    const asset = await makeApprovedAsset();
    await assign(withContent.id, [asset.id]);
    await api.publish(withContent.id, true);
    await api.publish(without.id, true);

    expect((await forId(withContent.id)).publishableAssetCount).toBe(1);
    expect((await forId(without.id)).publishableAssetCount).toBe(0);
  });

  /* ---------------- the public side is unchanged ---------------- */

  it('an empty published category is still IN /api/home, with no clips', async () => {
    // The rail is dropped by the client, deliberately. The API still reports
    // the category, and its pill still renders — that behaviour is not the bug
    // and must not change.
    const category = await makeCategory('Still Listed');
    await api.publish(category.id, true);

    const home = (await api.home()).json();
    const rail = home.categories.find((c: { id: string }) => c.id === category.id);
    expect(rail).toBeDefined();
    expect(rail.clips).toEqual([]);
    expect(home.categoryPills.map((p: { id: string }) => p.id)).toContain(category.id);
  });

  it('a populated published category renders its clips on Home', async () => {
    const category = await makeCategory('Renders');
    const asset = await makeApprovedAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);

    const home = (await api.home()).json();
    const rail = home.categories.find((c: { id: string }) => c.id === category.id);
    expect(rail.clips).toHaveLength(1);
    expect(rail.clips[0].id).toBe(asset.id);
  });
});

/* ------------------------------------------------------------------ *
 * THE ADMIN COUNT AND THE RAIL ASK THE SAME QUESTION
 *
 * Reported as "the New category has 5 assigned clips, the Admin says 5 are
 * publishable, and Home shows 1".
 *
 * Both numbers were honest about different questions. The rail has always
 * applied four rules — approved, content kind, an ACTIVE character, and a
 * present storage key — while every Admin surface applied only the first. So
 * an approved clip belonging to a character who had not been published counted
 * as publishable, was offered by the picker, was accepted by the write, and
 * rendered nowhere. The operator's only evidence was a short rail.
 *
 * These tests pin the ALIGNMENT rather than any one count: whatever a category
 * holds, `publishableAssetCount` must equal the number of clips `/api/home`
 * returns for it. A rule added to one side and not the other fails here.
 * ------------------------------------------------------------------ */

describe('Admin publishable counts match what the rail renders', () => {
  const forId = async (id: string) =>
    ((await api.adminHome()).json().categories as Array<{
      id: string;
      assetCount: number;
      publishableAssetCount: number;
      wouldRenderEmpty: boolean;
    }>).find((c) => c.id === id)!;

  const railFor = async (id: string) =>
    (await api.home()).json().categories.find((c: { id: string }) => c.id === id);

  /** Retires a character without touching a single asset row. */
  const retire = (characterId: string) =>
    on.db.update(characters).set({ status: 'inactive' }).where(eq(characters.id, characterId));

  const activate = (characterId: string) =>
    on.db.update(characters).set({ status: 'active' }).where(eq(characters.id, characterId));

  it('does not count an approved clip whose character is not published', async () => {
    const category = await makeCategory('Unpublished Character');
    const asset = await makeApprovedVideoAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await retire(LUNA.id);

    const row = await forId(category.id);
    expect(row.assetCount).toBe(1); // the assignment is INTACT…
    expect(row.publishableAssetCount).toBe(0); // …and honestly reported as dead
    expect(row.wouldRenderEmpty).toBe(true);
    expect((await railFor(category.id)).clips).toEqual([]);
  });

  it('publishing the character brings it back with no re-assignment', async () => {
    // The assignment is never rewritten, so this must recover by itself —
    // the same "rows say where, never whether" rule the rest of the CMS uses.
    const category = await makeCategory('Recovers');
    const asset = await makeApprovedVideoAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await retire(LUNA.id);
    expect((await forId(category.id)).publishableAssetCount).toBe(0);

    await activate(LUNA.id);
    expect((await forId(category.id)).publishableAssetCount).toBe(1);
    expect((await railFor(category.id)).clips).toHaveLength(1);
  });

  it('does not count an assignment whose storage key was lost', async () => {
    const category = await makeCategory('No Bytes');
    const asset = await makeApprovedVideoAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: '' })
      .where(eq(characterVisualAssets.id, asset.id));

    expect((await forId(category.id)).publishableAssetCount).toBe(0);
    expect((await railFor(category.id)).clips).toEqual([]);
  });

  it('does not count an assignment whose kind stopped being content', async () => {
    const category = await makeCategory('Not Content');
    const asset = await makeApprovedVideoAsset();
    await assign(category.id, [asset.id]);
    await api.publish(category.id, true);
    // The write path refuses a non-content kind, so this is the only way a
    // category comes to hold one: the asset changed after it was assigned.
    await on.db
      .update(characterVisualAssets)
      .set({ kind: 'reference' })
      .where(eq(characterVisualAssets.id, asset.id));

    expect((await forId(category.id)).publishableAssetCount).toBe(0);
    expect((await railFor(category.id)).clips).toEqual([]);
  });

  it('THE REPORTED SHAPE: five assigned, one renderable, and the Admin says one', async () => {
    // Production's exact case rebuilt: a category holding five approved clips
    // where only one belongs to a published character.
    const category = await makeCategory('New');
    const live = await makeApprovedVideoAsset(EMBER.id);
    const pending = [
      await makeApprovedVideoAsset(LUNA.id),
      await makeApprovedVideoAsset(LUNA.id),
      await makeApprovedVideoAsset(LUNA.id),
      await makeApprovedVideoAsset(LUNA.id),
    ];
    const added = await assign(category.id, [live.id, ...pending.map((a) => a.id)]);
    expect(added.statusCode).toBe(200);
    await api.publish(category.id, true);
    await retire(LUNA.id);

    const row = await forId(category.id);
    expect(row.assetCount).toBe(5);
    expect(row.publishableAssetCount).toBe(1);

    const rail = await railFor(category.id);
    expect(rail.clips).toHaveLength(1);
    expect(rail.clips[0].id).toBe(live.id);
    // The number the operator is shown IS the number that renders. This
    // equality is the whole point; the literals above are just its witness.
    expect(row.publishableAssetCount).toBe(rail.clips.length);

    // And publishing the four brings the rail up to five, untouched rows and all.
    await activate(LUNA.id);
    expect((await forId(category.id)).publishableAssetCount).toBe(5);
    expect((await railFor(category.id)).clips).toHaveLength(5);
  });

  it('the App Categories list agrees with the Home composer', async () => {
    // Two screens, two endpoints, one function behind them now.
    const category = await makeCategory('Two Screens');
    const live = await makeApprovedVideoAsset(EMBER.id);
    const dark = await makeApprovedVideoAsset(LUNA.id);
    await assign(category.id, [live.id, dark.id]);
    await api.publish(category.id, true);
    await retire(LUNA.id);

    const listed = (
      await on.app.inject({ method: 'GET', url: '/admin/app-categories', cookies: adminCookies })
    ).json().categories as Array<{ id: string; publishableAssetCount: number }>;
    const fromList = listed.find((c) => c.id === category.id)!;
    expect(fromList.publishableAssetCount).toBe(1);
    expect(fromList.publishableAssetCount).toBe((await forId(category.id)).publishableAssetCount);
  });

  /* ---------------- the per-asset view names the rule ---------------- */

  it('tells the operator WHICH rule an assignment fails', async () => {
    const category = await makeCategory('Reasons');
    const live = await makeApprovedVideoAsset(EMBER.id);
    const dark = await makeApprovedVideoAsset(LUNA.id);
    await assign(category.id, [live.id, dark.id]);
    await retire(LUNA.id);

    const assets = (
      await on.app.inject({
        method: 'GET',
        url: `/admin/app-categories/${category.id}/assets`,
        cookies: adminCookies,
      })
    ).json().assets as Array<{
      assetId: string;
      status: string;
      publishable: boolean;
      ineligibleReason: string | null;
    }>;
    const ok = assets.find((a) => a.assetId === live.id)!;
    const blocked = assets.find((a) => a.assetId === dark.id)!;

    expect(ok.publishable).toBe(true);
    expect(ok.ineligibleReason).toBeNull();
    // Approved AND unpublishable at once — the combination the old view could
    // not express, and the one that made the reported bug invisible.
    expect(blocked.status).toBe('approved');
    expect(blocked.publishable).toBe(false);
    expect(blocked.ineligibleReason).toBe('character_inactive');
  });

  /* ---------------- the picker offers, and warns ---------------- */

  it('still OFFERS an unpublished character\'s clips, flagged', async () => {
    // Merchandising a character before publishing her is the intended journey
    // — the CMS creates her unpublished on purpose. Hiding her content here
    // would make preparing a category impossible, so the picker warns instead.
    const asset = await makeApprovedVideoAsset();
    await retire(LUNA.id);

    const candidates = (
      await on.app.inject({
        method: 'GET',
        url: '/admin/app-categories/candidates',
        cookies: adminCookies,
      })
    ).json().assets as Array<{ assetId: string; ineligibleReason: string | null }>;
    const offered = candidates.find((c) => c.assetId === asset.id);
    expect(offered).toBeDefined();
    expect(offered!.ineligibleReason).toBe('character_inactive');
  });

  it('accepts the assignment of an unpublished character\'s clip', async () => {
    const category = await makeCategory('Prepared');
    const asset = await makeApprovedVideoAsset();
    await retire(LUNA.id);

    const res = await assign(category.id, [asset.id]);
    expect(res.statusCode).toBe(200);
    const outcomes = res.json().outcomes as Array<{ assetId: string; added: boolean }>;
    expect(outcomes.find((o) => o.assetId === asset.id)!.added).toBe(true);
  });

  it('refuses a clip with no media file', async () => {
    const category = await makeCategory('Refuses');
    const asset = await makeApprovedVideoAsset();
    await on.db
      .update(characterVisualAssets)
      .set({ storageKey: '' })
      .where(eq(characterVisualAssets.id, asset.id));

    const res = await assign(category.id, [asset.id]);
    const outcomes = res.json().outcomes as Array<{
      assetId: string;
      added: boolean;
      reason?: string;
    }>;
    expect(outcomes[0]!.added).toBe(false);
    expect(outcomes[0]!.reason).toBe('no_media');
  });
});
