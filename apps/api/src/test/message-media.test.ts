import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { characterVisualAssets, messages, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters, seedVisualIdentities } from '../db/seed.js';
import { createVisualAsset } from '../services/visual-asset-service.js';
import { getActiveVisualIdentity } from '../services/visual-identity-service.js';
import {
  isInsideStorageRoot,
  resolveMediaFile,
  mediaUrlFor,
} from '../services/message-media-service.js';
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
 * Character Media Messages, commit 1 — plumbing and serving.
 *
 * Nothing in the shipped code writes messages.media_asset_id, so these tests
 * attach media the way a LATER commit will: by setting the column directly.
 * That is deliberate — it proves the read/serve half is correct and safe
 * BEFORE any selection logic exists to exercise it.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;
const STORAGE_DIR = testEnv.media.storageDir;
/** Deliberately a sibling of the storage root, not a child of it. */
const OUTSIDE_DIR = join(tmpdir(), 'over18-test-media-outside');

let ctx: TestContext;

/** A minimal valid PNG (1x1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal real-shaped MP4 (ftyp box). */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
  Buffer.alloc(32, 0x21),
]);

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});

afterAll(async () => {
  rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
  await seedVisualIdentities(ctx.db);
});

async function registerUser(email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'media-test-pass1' },
  });
  const c = extractSessionCookie(res)!;
  return { userId: res.json().id as string, cookies: { [c.name]: c.value } };
}

async function startConversation(cookies: Record<string, string>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { characterId: LUNA.id },
    cookies,
  });
  return res.json().id as string;
}

async function setupUser(email: string) {
  const { userId, cookies } = await registerUser(email);
  return { userId, cookies, conversationId: await startConversation(cookies) };
}

/** Sends a real exchange and returns the character message's id. */
async function sendAndGetCharacterMessageId(
  cookies: Record<string, string>,
  conversationId: string,
  content = 'hello',
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversationId}/messages`,
    payload: { content },
    cookies,
  });
  return res.json().characterMessage.id as string;
}

/**
 * A GENERATED-convention asset: storage_key IS the filesystem path.
 * Writes real bytes unless `writeFile` is false (for the missing-file case).
 */
async function createGeneratedAsset(options: {
  filename: string;
  bytes: Buffer;
  dir?: string;
  writeFile?: boolean;
}): Promise<string> {
  const identity = (await getActiveVisualIdentity(ctx.db, LUNA.id))!;
  const dir = options.dir ?? join(STORAGE_DIR, LUNA.id, 'generated');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, options.filename);
  if (options.writeFile !== false) writeFileSync(path, options.bytes);
  const asset = await createVisualAsset(ctx.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    storageKey: path,
    provenance: { source: 'test-generated' },
  });
  return asset.id;
}

/** An UPLOAD-convention asset: route in storage_key, real path in provenance. */
async function createUploadedAsset(options: {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  contentRating?: 'sfw' | 'explicit';
}): Promise<string> {
  const identity = (await getActiveVisualIdentity(ctx.db, LUNA.id))!;
  const dir = join(STORAGE_DIR, LUNA.id, 'uploads');
  mkdirSync(dir, { recursive: true });
  const asset = await createVisualAsset(ctx.db, {
    characterId: LUNA.id,
    visualIdentityId: identity.id,
    kind: 'generated',
    status: 'approved',
    contentRating: options.contentRating ?? 'sfw',
  });
  const storagePath = join(dir, `${asset.id}-${options.filename}`);
  writeFileSync(storagePath, options.bytes);
  await ctx.db
    .update(characterVisualAssets)
    .set({
      storageKey: `/admin/content/uploads/${asset.id}/file`,
      provenance: {
        source: 'manual-upload',
        mimeType: options.mimeType,
        mediaType: options.mimeType.startsWith('video/') ? 'video' : 'image',
        storagePath,
      },
    })
    .where(eq(characterVisualAssets.id, asset.id));
  return asset.id;
}

/** What a later commit will do inside sendMessage; here, done directly. */
async function attach(messageId: string, assetId: string | null): Promise<void> {
  await ctx.db
    .update(messages)
    .set({ mediaAssetId: assetId })
    .where(eq(messages.id, messageId));
}

function fetchMedia(
  cookies: Record<string, string> | undefined,
  conversationId: string,
  messageId: string,
) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/messages/${messageId}/media`,
    ...(cookies ? { cookies } : {}),
  });
}

function listMessages(cookies: Record<string, string>, conversationId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/messages`,
    cookies,
  });
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

describe('ChatMessage serialization', () => {
  it('a message without media serialises EXACTLY as before (no media key at all)', async () => {
    const owner = await setupUser('media.ser1@example.com');
    await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);

    const history = (await listMessages(owner.cookies, owner.conversationId)).json();
    expect(history).toHaveLength(2);
    for (const message of history) {
      // The exact pre-existing key set — not merely "media is falsy".
      expect(Object.keys(message).sort()).toEqual(['content', 'createdAt', 'id', 'sender']);
      expect('media' in message).toBe(false);
    }
  });

  it('the send response is unchanged for a normal exchange', async () => {
    const owner = await setupUser('media.ser2@example.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${owner.conversationId}/messages`,
      payload: { content: 'hi' },
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body.userMessage).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'sender',
    ]);
    expect(Object.keys(body.characterMessage).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'sender',
    ]);
  });

  it('a message WITH media serialises type + opaque url, and nothing internal', async () => {
    const owner = await setupUser('media.ser3@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    const assetId = await createUploadedAsset({
      filename: 'luna.png',
      mimeType: 'image/png',
      bytes: PNG,
    });
    await attach(messageId, assetId);

    const history = (await listMessages(owner.cookies, owner.conversationId)).json();
    const withMedia = history.find((m: { id: string }) => m.id === messageId);

    expect(withMedia.media).toEqual({
      type: 'image',
      url: `/api/conversations/${owner.conversationId}/messages/${messageId}/media`,
    });
    // The text message in the same history is untouched.
    expect('media' in history.find((m: { id: string }) => m.id !== messageId)).toBe(false);

    // Nothing internal anywhere in the payload.
    const raw = JSON.stringify(history);
    expect(raw).not.toContain(assetId);
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain('storagePath');
    expect(raw).not.toContain('provenance');
    expect(raw).not.toContain(STORAGE_DIR);
    expect(raw).not.toContain('/admin/');
  });

  it('classifies a video asset as video', async () => {
    const owner = await setupUser('media.ser4@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(messageId, await createGeneratedAsset({ filename: 'clip.mp4', bytes: MP4 }));

    const history = (await listMessages(owner.cookies, owner.conversationId)).json();
    expect(history.find((m: { id: string }) => m.id === messageId).media.type).toBe('video');
  });

  it('a message whose asset was deleted from the Library still returns its text', async () => {
    const owner = await setupUser('media.ser5@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    const assetId = await createUploadedAsset({
      filename: 'gone.png',
      mimeType: 'image/png',
      bytes: PNG,
    });
    await attach(messageId, assetId);

    // ON DELETE SET NULL — the message must survive, without media.
    await ctx.db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));

    const history = (await listMessages(owner.cookies, owner.conversationId)).json();
    expect(history).toHaveLength(2);
    const message = history.find((m: { id: string }) => m.id === messageId);
    expect(message.content.length).toBeGreaterThan(0);
    expect('media' in message).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe('GET /api/conversations/:id/messages/:id/media — authorization', () => {
  it('the conversation owner can fetch media attached to their message', async () => {
    const owner = await setupUser('media.auth1@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'ok.png', mimeType: 'image/png', bytes: PNG }),
    );

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it('another user cannot fetch it (404, not 403 — no existence leak)', async () => {
    const owner = await setupUser('media.auth2a@example.com');
    const intruder = await setupUser('media.auth2b@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'private.png', mimeType: 'image/png', bytes: PNG }),
    );

    const res = await fetchMedia(intruder.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.equals(PNG)).toBe(false);
  });

  it('an unauthenticated request is 401', async () => {
    const owner = await setupUser('media.auth3@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'a.png', mimeType: 'image/png', bytes: PNG }),
    );

    expect((await fetchMedia(undefined, owner.conversationId, messageId)).statusCode).toBe(401);
  });

  it('an unknown or malformed conversation id is 404', async () => {
    const owner = await setupUser('media.auth4@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'b.png', mimeType: 'image/png', bytes: PNG }),
    );

    const unknown = await fetchMedia(
      owner.cookies,
      '00000000-0000-4000-8000-999999999999',
      messageId,
    );
    expect(unknown.statusCode).toBe(404);

    const malformed = await fetchMedia(owner.cookies, 'not-a-uuid', messageId);
    expect(malformed.statusCode).toBe(404);
  });

  it('a message from ANOTHER conversation cannot be fetched through this one', async () => {
    const owner = await registerUser('media.auth5@example.com');
    const conversationA = await startConversation(owner.cookies);
    const messageA = await sendAndGetCharacterMessageId(owner.cookies, conversationA, 'in A');
    await attach(
      messageA,
      await createUploadedAsset({ filename: 'c.png', mimeType: 'image/png', bytes: PNG }),
    );

    // A second conversation owned by the SAME user: ownership alone is not
    // enough, the message must belong to the conversation in the path.
    const other = await setupUser('media.auth5b@example.com');
    const crossed = await fetchMedia(owner.cookies, other.conversationId, messageA);
    expect(crossed.statusCode).toBe(404);

    // And the owner's own valid pairing still works, proving the 404 above is
    // the mismatch and not a broken fixture.
    expect((await fetchMedia(owner.cookies, conversationA, messageA)).statusCode).toBe(200);
  });

  it('a message with NO attached asset is 404, even for the owner', async () => {
    const owner = await setupUser('media.auth6@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);

    // The asset exists in the Library but is attached to nothing.
    await createUploadedAsset({ filename: 'unattached.png', mimeType: 'image/png', bytes: PNG });

    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(404);
  });

  it('detaching an asset makes it immediately unreachable again', async () => {
    const owner = await setupUser('media.auth7@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    const assetId = await createUploadedAsset({
      filename: 'detach.png',
      mimeType: 'image/png',
      bytes: PNG,
    });

    await attach(messageId, assetId);
    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(200);

    await attach(messageId, null);
    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(404);
  });

  it('an EXPLICIT asset is reachable only through a message the caller owns', async () => {
    const owner = await setupUser('media.auth8a@example.com');
    const intruder = await setupUser('media.auth8b@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    const assetId = await createUploadedAsset({
      filename: 'explicit.png',
      mimeType: 'image/png',
      bytes: PNG,
      contentRating: 'explicit',
    });

    // Not attached: nobody can reach it, because no route names an asset id.
    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(404);

    await attach(messageId, assetId);
    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(200);
    expect((await fetchMedia(intruder.cookies, owner.conversationId, messageId)).statusCode).toBe(
      404,
    );
  });

  it('is not admin-gated: an ordinary non-admin user can read their own media', async () => {
    const owner = await setupUser('media.auth9@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'd.png', mimeType: 'image/png', bytes: PNG }),
    );

    const [row] = await ctx.db.select().from(users).where(eq(users.id, owner.userId));
    expect(row!.role).toBe('user'); // genuinely not an admin
    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * Storage conventions, path safety and content types
 * ------------------------------------------------------------------ */

describe('storage conventions and path safety', () => {
  it('serves a manual UPLOAD via provenance.storagePath with its recorded mime type', async () => {
    const owner = await setupUser('media.path1@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createUploadedAsset({ filename: 'up.mp4', mimeType: 'video/mp4', bytes: MP4 }),
    );

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload.equals(MP4)).toBe(true);
  });

  it('serves a GENERATED asset whose storage_key IS the path, typed by extension', async () => {
    const owner = await setupUser('media.path2@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(messageId, await createGeneratedAsset({ filename: 'gen.mp4', bytes: MP4 }));

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload.equals(MP4)).toBe(true);
  });

  it('serves a generated PNG with image/png', async () => {
    const owner = await setupUser('media.path3@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(messageId, await createGeneratedAsset({ filename: 'gen.png', bytes: PNG }));

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('returns 404 (never 500) when the row exists but the file is gone', async () => {
    const owner = await setupUser('media.path4@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    await attach(
      messageId,
      await createGeneratedAsset({ filename: 'missing.png', bytes: PNG, writeFile: false }),
    );

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('REFUSES a path outside MEDIA_STORAGE_DIR even though the file exists', async () => {
    const owner = await setupUser('media.path5@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    // A real, readable file deliberately placed outside the storage root.
    await attach(
      messageId,
      await createGeneratedAsset({ filename: 'escaped.png', bytes: PNG, dir: OUTSIDE_DIR }),
    );

    const res = await fetchMedia(owner.cookies, owner.conversationId, messageId);
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.equals(PNG)).toBe(false);
  });

  it('REFUSES a traversal path that climbs out of the storage root', async () => {
    const owner = await setupUser('media.path6@example.com');
    const messageId = await sendAndGetCharacterMessageId(owner.cookies, owner.conversationId);
    const identity = (await getActiveVisualIdentity(ctx.db, LUNA.id))!;
    mkdirSync(OUTSIDE_DIR, { recursive: true });
    writeFileSync(join(OUTSIDE_DIR, 'traversed.png'), PNG);

    const asset = await createVisualAsset(ctx.db, {
      characterId: LUNA.id,
      visualIdentityId: identity.id,
      kind: 'generated',
      status: 'approved',
      storageKey: join(STORAGE_DIR, '..', 'over18-test-media-outside', 'traversed.png'),
      provenance: { source: 'test-generated' },
    });
    await attach(messageId, asset.id);

    expect((await fetchMedia(owner.cookies, owner.conversationId, messageId)).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Pure units
 * ------------------------------------------------------------------ */

describe('isInsideStorageRoot', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isInsideStorageRoot('/app/var/media', '/app/var/media')).toBe(true);
    expect(isInsideStorageRoot('/app/var/media', '/app/var/media/luna/a.png')).toBe(true);
    expect(isInsideStorageRoot('/app/var/media/', '/app/var/media/luna/a.png')).toBe(true);
  });

  it('rejects siblings, prefix look-alikes and traversal', () => {
    expect(isInsideStorageRoot('/app/var/media', '/app/var/other/a.png')).toBe(false);
    // The critical one: a sibling directory sharing the root's name prefix.
    expect(isInsideStorageRoot('/app/var/media', '/app/var/media-evil/a.png')).toBe(false);
    expect(isInsideStorageRoot('/app/var/media', '/app/var/media/../../../etc/passwd')).toBe(false);
    expect(isInsideStorageRoot('/app/var/media', '/etc/passwd')).toBe(false);
  });
});

describe('resolveMediaFile', () => {
  const base = {
    id: 'a',
    characterId: 'c',
    visualIdentityId: 'v',
    kind: 'generated' as const,
    status: 'approved' as const,
    isCanonical: false,
    position: null,
    contentRating: 'sfw' as const,
    requirementKey: null,
    approvedBy: null,
    approvedAt: null,
    // Release time. Irrelevant to file RESOLUTION, which is what these cases
    // exercise — the publication gate is applied before a row ever reaches here.
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('prefers the upload convention when BOTH are populated', () => {
    // A manual upload has a route in storage_key AND a real path in provenance.
    // Reading storage_key as a path here would be nonsense, so it must lose.
    const resolved = resolveMediaFile(
      {
        ...base,
        storageKey: '/admin/content/uploads/abc/file',
        provenance: {
          source: 'manual-upload',
          mimeType: 'image/webp',
          mediaType: 'image',
          storagePath: '/app/var/media/c/uploads/abc.webp',
        },
      },
      '/app/var/media',
    );
    expect(resolved).toEqual({
      path: '/app/var/media/c/uploads/abc.webp',
      contentType: 'image/webp',
      mediaType: 'image',
    });
  });

  it('reports no_path when neither convention is populated', () => {
    expect(resolveMediaFile({ ...base, storageKey: null, provenance: {} }, '/app/var/media')).toEqual(
      { failure: 'no_path' },
    );
  });

  it('reports outside_storage_root for either convention', () => {
    expect(
      resolveMediaFile({ ...base, storageKey: '/etc/passwd', provenance: {} }, '/app/var/media'),
    ).toEqual({ failure: 'outside_storage_root' });

    expect(
      resolveMediaFile(
        {
          ...base,
          storageKey: '/admin/content/uploads/abc/file',
          provenance: { source: 'manual-upload', mimeType: 'image/png', storagePath: '/etc/shadow' },
        },
        '/app/var/media',
      ),
    ).toEqual({ failure: 'outside_storage_root' });
  });

  it('never treats an upload route path as a filesystem path', () => {
    // provenance says manual-upload but storagePath is missing: it must fall
    // through to the generated branch and be refused, NOT open '/admin/...'.
    const resolved = resolveMediaFile(
      {
        ...base,
        storageKey: '/admin/content/uploads/abc/file',
        provenance: { source: 'manual-upload', mimeType: 'image/png' },
      },
      '/app/var/media',
    );
    expect(resolved).toEqual({ failure: 'outside_storage_root' });
  });
});

describe('mediaUrlFor', () => {
  it('is message-scoped and carries no asset identifier', () => {
    expect(mediaUrlFor('conv-1', 'msg-2')).toBe('/api/conversations/conv-1/messages/msg-2/media');
  });
});
