import { createReadStream, existsSync } from 'node:fs';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/client.js';
import {
  approveVisualAsset,
  getVisualAssetById,
  rejectVisualAsset,
  VisualAssetNotFoundError,
  VisualAssetTransitionError,
  type ContentRating,
  type VisualAssetStatus,
} from '../services/visual-asset-service.js';
import {
  acceptedMediaTypeOf,
  deleteLibraryAsset,
  LibraryDeleteError,
  LibraryUploadError,
  uploadLibraryAsset,
  uploadedMimeTypeOf,
  uploadedPathOf,
  type LibraryUploadStorage,
} from '../services/library-upload-service.js';
import {
  getReviewAsset,
  listLibrary,
  listRecentLibrary,
  listReviewQueue,
  summariseReviewByCharacter,
  updateAssetMetadata,
  type LibraryAsset,
  type MediaType,
  setAssetPublished,
} from '../services/content-review-service.js';
import {
  ContentInboxError,
  assignInboxItem,
  createInboxItem,
  discardInboxItem,
  getInboxItem,
  inboxPathOf,
  inboxView,
  listInbox,
} from '../services/content-inbox-service.js';
import {
  getContentRequirementByKey,
  listEnabledContentRequirements,
} from '../services/content-requirements-service.js';
import {
  getRequirementStatus,
  summariseRequirementProgress,
} from '../services/requirement-status-service.js';
import { getCharacterForAdmin } from '../services/character-service.js';
import { resolveMediaFile } from '../services/message-media-service.js';
import {
  adoptOptimisedDerivative,
  revokeOptimisedDerivative,
} from '../services/media-optimise-service.js';

/**
 * US-106 — admin content review API.
 *
 * Every route is `requireAuth` + `requireAdmin`, reusing the existing session
 * auth established in US-99/US-103. No new lifecycle: approve and reject are
 * the existing EPIC 7 operations, and "remove" is a REJECT, never a delete, so
 * provenance survives.
 */
const RATINGS: ContentRating[] = ['sfw', 'explicit'];

/**
 * The Character page's content shelves.
 *
 * The upload route accepts a SHELF NAME and derives the asset's kind, approval
 * and accepted media types from it. It deliberately does NOT accept a kind: a
 * client that could name a kind could put its own upload on the front page, or
 * keep it off every surface — `kind` is the axis the public boundary is built
 * on, so it stays the server's to decide.
 */
const CHARACTER_SHELVES = ['regular', 'explicit', 'chat'] as const;
type CharacterShelf = (typeof CHARACTER_SHELVES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assetView(a: Awaited<ReturnType<typeof getReviewAsset>>) {
  if (!a) return null;
  const provenance = (a.provenance ?? {}) as Record<string, unknown>;
  return {
    assetId: a.id,
    characterId: a.characterId,
    characterName: a.characterName,
    visualIdentityId: a.visualIdentityId,
    mediaType: a.mediaType,
    status: a.status,
    kind: a.kind,
    contentRating: a.contentRating,
    /** Which configured requirement this item is filed under, if any. */
    requirementKey: a.requirementKey,
    /** DB column is is_canonical; the product term is Primary. */
    isPrimary: a.isCanonical,
    position: a.position,
    /**
     * OPAQUE MEDIA LOCATOR. Was `storageKey`, which handed the browser either a
     * route (manual uploads) or a raw server filesystem path (generated
     * assets) — the second is both broken as a URL and a disclosure of the
     * server's layout. The client now receives a route keyed by asset id and
     * nothing else; the two storage conventions are resolved server-side.
     */
    previewUrl: a.storageKey ? `/admin/content/assets/${a.id}/file` : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    approvedAt: a.approvedAt,
    // Only what the model actually stores — nothing invented.
    provenance: {
      jobId: provenance.jobId ?? null,
      provider: provenance.provider ?? null,
      model: provenance.model ?? null,
      generatedAt: provenance.generatedAt ?? null,
    },
  };
}

/** Library view = the review view plus why the item counts as recent. */
function libraryView(a: LibraryAsset) {
  return { ...assetView(a)!, recencyBasis: a.recencyBasis, recentAt: a.recentAt };
}

/** Max bytes accepted for one manual upload (videos need real headroom). */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export default async function adminContentRoutes(
  app: FastifyInstance,
  opts: { db: Db; uploadStorage?: LibraryUploadStorage; optimisedMedia?: boolean },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  /**
   * Where every asset's bytes live. Same directory the upload path writes to;
   * resolveMediaFile refuses anything that resolves outside it.
   */
  const mediaStorageDir = opts.uploadStorage?.storageDir ?? null;

  // Scoped to this plugin: multipart parsing exists only where uploads land.
  await app.register(multipart, {
    limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 8, fieldSize: 4096 },
  });

  /**
   * Resolves a caller-supplied requirement key against the CONFIGURED set, and
   * against the medium of the thing being filed.
   *
   * Returns the key, `null` for "no category", or a failure. Filing a video
   * under an image requirement is refused rather than accepted: the asset would
   * be stored, look filed, and count toward nothing — the exact invisible
   * failure this phase exists to remove. No key is ever defaulted or invented.
   */
  type KeyResolution =
    | { ok: true; key: string | null }
    | { ok: false; error: 'unknown_requirement' | 'media_mismatch'; message: string };

  const resolveRequirementKey = async (
    raw: unknown,
    mediaType?: MediaType,
  ): Promise<KeyResolution> => {
    if (raw === undefined || raw === null) return { ok: true, key: null };
    const key = String(raw).trim();
    if (key.length === 0) return { ok: true, key: null };

    const requirement = await getContentRequirementByKey(opts.db, key);
    if (!requirement) {
      return {
        ok: false,
        error: 'unknown_requirement',
        message: 'That content category is not configured.',
      };
    }
    if (mediaType && requirement.mediaType !== mediaType) {
      return {
        ok: false,
        error: 'media_mismatch',
        message: `"${requirement.label}" needs ${requirement.mediaType} content, so a ${mediaType} cannot count toward it.`,
      };
    }
    return { ok: true, key };
  };

  const refuseKey = (reply: FastifyReply, resolution: Extract<KeyResolution, { ok: false }>) =>
    reply.code(400).send({ error: resolution.error, message: resolution.message });

  /**
   * US-100 — the Content Library. One request returns BOTH the recent strip and
   * the filtered library, so the operator sees what just changed without
   * searching, and the UI needs no second round trip to render its default view.
   */
  app.get<{
    Querystring: { characterId?: string; status?: string; mediaType?: string; search?: string };
  }>('/admin/content/library', adminOnly, async (request, reply) => {
    const q = request.query;
    const filtered = Object.keys(q).length > 0;
    const [recent, all] = await Promise.all([
      listRecentLibrary(opts.db),
      listLibrary(opts.db, {
        characterId: q.characterId,
        status: q.status as never,
        mediaType: q.mediaType as MediaType | undefined,
        search: q.search,
      }),
    ]);
    return reply.send({
      // Recent is always present and always first — it is the default view, not
      // a filter the operator has to discover.
      recent: recent.map(libraryView),
      assets: all.map(libraryView),
      filtered,
    });
  });

  /**
   * Manual upload for a KNOWN character. NOT generation: no provider, model,
   * cost or job is involved.
   *
   * LIFECYCLE FIX: this used to approve on arrival, which put uploaded content
   * straight into the Library and bypassed Review entirely — one workflow for
   * generated content and a different one for uploads. It now lands in
   * `under_review`, exactly where generated content lands, so both origins meet
   * the same queue and the Library still begins at approval.
   *
   * Upload without a character is a different route: /admin/content/inbox.
   */
  app.post('/admin/content/uploads', adminOnly, async (request, reply) => {
    if (!opts.uploadStorage) {
      return reply.code(503).send({
        error: 'uploads_unavailable',
        message: 'Media storage is not configured for this environment.',
      });
    }
    const file = await request.file();
    if (!file) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'A file part is required.' });
    }
    // Multipart fields arrive alongside the file part.
    const characterId = (file.fields.characterId as { value?: string } | undefined)?.value;
    if (typeof characterId !== 'string' || !UUID_RE.test(characterId)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'characterId must be a character UUID.' });
    }
    const rating = (file.fields.contentRating as { value?: string } | undefined)?.value;
    if (rating !== undefined && !RATINGS.includes(rating as ContentRating)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'contentRating must be sfw or explicit.' });
    }

    /**
     * WHICH CHARACTER-PAGE SHELF THIS UPLOAD CAME FROM, if any.
     *
     * The browser names a SHELF. It never names a kind, a status or an
     * approval — the server derives all three from the shelf below. That
     * asymmetry is the whole security property: `kind` decides which surfaces
     * an asset may ever reach, so a client that could set it could publish its
     * own private media or hide its own public media.
     *
     * ABSENT is the Content Library, unchanged in every respect: the upload
     * lands `under_review`, kind `generated`, and an operator decides in
     * Review exactly as before.
     */
    const section = (file.fields.section as { value?: string } | undefined)?.value;
    if (section !== undefined && !CHARACTER_SHELVES.includes(section as CharacterShelf)) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'section must be regular, explicit or chat.',
      });
    }
    const shelf = section as CharacterShelf | undefined;

    /**
     * The shelf's rules, in one place.
     *
     * Regular and Explicit are VIDEO shelves: an image there would become
     * approved content that every public clip surface then has to filter out
     * again, which is the class of leak this product has already fixed twice.
     *
     * Chat Content accepts BOTH, because a character sending a photo in a
     * conversation is the ordinary case — and it is safe to accept here
     * precisely because `kind: 'chat'` keeps it off every public surface.
     */
    const uploadedType = acceptedMediaTypeOf(file.mimetype);
    if (shelf === 'regular' || shelf === 'explicit') {
      if (uploadedType !== 'video') {
        return reply.code(400).send({
          error: 'unsupported_type',
          message:
            'Regular and Explicit accept video only. Upload an image through Chat Content, Visual identity or the Content Library.',
        });
      }
    }

    const requested = await resolveRequirementKey(
      (file.fields.requirementKey as { value?: string } | undefined)?.value,
      acceptedMediaTypeOf(file.mimetype) ?? undefined,
    );
    if (!requested.ok) return refuseKey(reply, requested);
    const requirementKey = requested.key;

    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `That file exceeds the ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
      });
    }

    try {
      const asset = await uploadLibraryAsset(opts.db, opts.uploadStorage, {
        characterId,
        mimeType: file.mimetype,
        bytes,
        originalName: file.filename,
        contentRating: rating as ContentRating | undefined,
        uploadedBy: request.currentUser?.id,
        /**
         * SERVER-DERIVED, never client-supplied.
         *
         * Chat Content is its own kind so that one column answers "where may
         * this asset appear?" — the chat selector reads `kind='chat'` and every
         * public surface refuses it. Regular and Explicit stay `generated`,
         * which is what they have always been, so no existing asset changes
         * meaning.
         */
        kind: shelf === 'chat' ? 'chat' : undefined,
        // Review by default; a Character-page shelf opts out. Uploading to a
        // character IS the editorial decision — a second queue to re-make it
        // was ceremony, not safety. The Content Library omits `section` and is
        // therefore untouched.
        approve: shelf !== undefined,
        /**
         * AND RELEASED, for the two shelves that ARE her page.
         *
         * This is the same editorial decision the line above already trusts,
         * recorded rather than implied: an operator putting a clip on her
         * Regular or Explicit shelf means it to appear on her Posts tab. Before
         * `published_at` existed there was nowhere to write that down, so Posts
         * fell back to asking whether the clip had been merchandised onto HOME
         * — a different decision entirely — and hid everything that had not.
         *
         * `chat` is excluded because Chat Content is private by construction,
         * and the Content Library (no `section`) is excluded because uploading
         * there is explicitly NOT a decision to publish — it lands in Review.
         */
        publish: shelf === 'regular' || shelf === 'explicit',
        // Optional, and never defaulted: the operator may say which requirement
        // this satisfies at upload time, or leave it for triage in Review.
        requirementKey,
      });
      return reply.code(201).send(assetView(await getReviewAsset(opts.db, asset.id)));
    } catch (err) {
      if (err instanceof LibraryUploadError) {
        return reply.code(400).send({ error: err.kind, message: err.message });
      }
      throw err;
    }
  });

  /** Streams an uploaded asset's bytes. Admin-only, like the rest of this API. */
  app.get<{ Params: { assetId: string } }>(
    '/admin/content/uploads/:assetId/file',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      const asset = await getVisualAssetById(opts.db, assetId);
      const path = asset ? uploadedPathOf(asset) : null;
      if (!asset || !path) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      if (!existsSync(path)) {
        return reply.code(404).send({
          error: 'file_missing',
          message: 'Upload row exists but the file is missing (storage may not be persistent).',
        });
      }
      reply.header('content-type', uploadedMimeTypeOf(asset));
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(path));
    },
  );

  /**
   * Streams an asset's bytes by ID — the ONLY media locator the admin client is
   * given (US-102.2).
   *
   * The two storage conventions disagree about what `storage_key` means: for a
   * manual upload it is a route and the real path lives in
   * provenance.storagePath; for a generated asset it IS the absolute path.
   * resolveMediaFile settles that and, more importantly, refuses any path that
   * escapes MEDIA_STORAGE_DIR — so the containment check is enforced here
   * rather than trusted from the column.
   *
   * Admin-only, like every other route in this plugin. A missing file is a
   * distinct 404 so an orphaned row (an ephemeral-disk redeploy) is diagnosable
   * rather than looking like a permissions problem.
   */
  /**
   * Adopt an optimised derivative for one asset.
   *
   * WHY THIS IS AN UPLOAD AND NOT A SERVER-SIDE ENCODE. The API image ships no
   * ffmpeg, and adding one is a build-configuration decision this work is
   * deliberately not taking. So the encode happens wherever an encoder already
   * exists and the finished file is presented here — which has a property a
   * server-side encoder would not: the operator can look at the result before
   * anything adopts it.
   *
   * NOTHING IS TRUSTED ABOUT THE FILE. It is written to a temp name, verified
   * on disk against the original it would replace, and only renamed into place
   * if every check passes. A refusal returns the checks that failed so the
   * answer is actionable rather than "no".
   *
   * ONE ASSET AT A TIME, ON PURPOSE. There is no bulk endpoint. Twenty-two
   * independent decisions, each individually revertible, is the migration.
   */
  app.post<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/optimised',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      if (!mediaStorageDir) {
        return reply
          .code(503)
          .send({ error: 'media_unavailable', message: 'Media storage is not configured.' });
      }
      const asset = await getVisualAssetById(opts.db, assetId);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }

      const file = await request.file();
      if (!file) {
        return reply
          .code(400)
          .send({ error: 'no_file', message: 'Attach the optimised .mp4 to adopt.' });
      }
      if (file.mimetype !== 'video/mp4') {
        return reply.code(400).send({
          error: 'unsupported_type',
          message: 'An optimised derivative must be video/mp4.',
        });
      }
      const bytes = await file.toBuffer();
      if (file.file.truncated) {
        return reply.code(413).send({
          error: 'file_too_large',
          message: `That file exceeds the ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
        });
      }

      const result = await adoptOptimisedDerivative(opts.db, asset, bytes, mediaStorageDir);
      if (!result.ok) {
        // The KIND of failure and the failing check names only. No path, no
        // storage key, no provenance — the same discipline every other media
        // route follows.
        request.log.warn(
          { assetId, adoption: result.failure, failed: result.verdict?.failed ?? [] },
          'refused to adopt an optimised derivative',
        );
        const status = result.failure === 'verification_failed' ? 422 : 400;
        return reply.code(status).send({
          error: result.failure,
          message:
            result.failure === 'verification_failed'
              ? 'The derivative did not match the original. Nothing was changed.'
              : 'The derivative could not be adopted. Nothing was changed.',
          checks: result.verdict?.checks ?? [],
          failed: result.verdict?.failed ?? [],
        });
      }

      return reply.send({
        assetId,
        adopted: true,
        checks: result.verdict?.checks ?? [],
        originalBytes: result.verdict?.originalFacts?.bytes ?? null,
        optimisedBytes: result.verdict?.derivativeFacts?.bytes ?? null,
      });
    },
  );

  /**
   * Stop serving one asset's derivative. The file stays on disk; only the key
   * that points at it is cleared, so this is reversible in both directions.
   */
  app.delete<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/optimised',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      const asset = await getVisualAssetById(opts.db, assetId);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      await revokeOptimisedDerivative(opts.db, asset);
      return reply.send({ assetId, adopted: false });
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/file',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      if (!mediaStorageDir) {
        return reply
          .code(503)
          .send({ error: 'media_unavailable', message: 'Media storage is not configured.' });
      }
      const asset = await getVisualAssetById(opts.db, assetId);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      const resolved = resolveMediaFile(asset, mediaStorageDir, {
        preferOptimised: opts.optimisedMedia === true,
      });
      if ('failure' in resolved) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      if (!existsSync(resolved.path)) {
        return reply.code(404).send({
          error: 'file_missing',
          message: 'Asset row exists but the file is missing (storage may not be persistent).',
        });
      }
      reply.header('content-type', resolved.contentType);
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(resolved.path));
    },
  );

  /**
   * Permanently deletes a Library asset and the file it owns.
   *
   * Distinct from reject (which preserves the row for the review workflow):
   * this is the Library's "get rid of it". Canonical assets are refused, so
   * the public gallery can never be changed here, and a missing file still
   * leaves the row removable — an orphaned entry can always be cleaned up.
   */
  app.delete<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId',
    adminOnly,
    async (request, reply) => {
      if (!opts.uploadStorage) {
        return reply.code(503).send({
          error: 'uploads_unavailable',
          message: 'Media storage is not configured for this environment.',
        });
      }
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      }
      try {
        const result = await deleteLibraryAsset(opts.db, opts.uploadStorage, assetId);
        return reply.send(result);
      } catch (err) {
        if (err instanceof LibraryDeleteError) {
          return reply
            .code(err.kind === 'not_found' ? 404 : 409)
            .send({ error: err.kind, message: err.message });
        }
        throw err;
      }
    },
  );

  /** Character-first entry: who has content waiting. */
  app.get('/admin/content/review/summary', adminOnly, async (_request, reply) => {
    return reply.send({ characters: await summariseReviewByCharacter(opts.db) });
  });

  /* ---------------------------------------------------------------- *
   * The Review WORKSPACE — required content, per character.
   *
   * One request renders the whole board: the character rail with progress, the
   * unassigned inbox count, and (when a character is named) that character's
   * requirements with the assets filling them. Every count comes from
   * requirement-status-service, which derives them from the configured
   * requirements and the actual assets — the same function the generation
   * planner uses, so a board and a plan can never disagree.
   * ---------------------------------------------------------------- */
  app.get<{ Querystring: { characterId?: string } }>(
    '/admin/content/review/workspace',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.query;
      const [progress, requirements, inbox] = await Promise.all([
        summariseRequirementProgress(opts.db),
        listEnabledContentRequirements(opts.db),
        listInbox(opts.db, { status: 'unassigned' }),
      ]);

      const base = {
        characters: progress,
        requirements,
        inbox: { unassignedCount: inbox.length },
      };
      if (!characterId) return reply.send({ ...base, selected: null });

      if (!UUID_RE.test(characterId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const character = await getCharacterForAdmin(opts.db, characterId);
      if (!character) {
        return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
      }
      const status = await getRequirementStatus(opts.db, characterId);

      return reply.send({
        ...base,
        selected: {
          character: {
            id: character.id,
            name: character.name,
            displayName: character.displayName,
            status: character.status,
          },
          totals: status.totals,
          // The board renders `required` capacity slots per entry — the
          // quantity is the configuration; slots are never stored.
          requirements: status.entries.map((entry) => ({
            key: entry.requirement.key,
            label: entry.requirement.label,
            mediaType: entry.requirement.mediaType,
            contentRating: entry.requirement.contentRating,
            required: entry.required,
            approved: entry.approved,
            pending: entry.pending,
            remaining: entry.remaining,
            surplus: entry.surplus,
            satisfied: entry.satisfied,
            assets: entry.assets.map((asset) =>
              assetView({ ...asset, characterName: character.name }),
            ),
          })),
          // Why each of these counts toward nothing, so the operator can fix it
          // rather than wonder about it.
          triage: status.triage.map((asset) => ({
            ...assetView({ ...asset, characterName: character.name })!,
            reason: asset.reason,
          })),
        },
      });
    },
  );

  /* ---------------------------------------------------------------- *
   * Unassigned inbox — upload without choosing a character first.
   *
   * These rows live in `content_inbox`, which has no character column, so an
   * unassigned upload is unreachable from every character-scoped query in the
   * product. Assignment CREATES a proper asset in `under_review`; it never
   * promotes anything past Review.
   * ---------------------------------------------------------------- */

  const storageUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({
      error: 'uploads_unavailable',
      message: 'Media storage is not configured for this environment.',
    });

  app.get('/admin/content/inbox', adminOnly, async (_request, reply) => {
    const items = await listInbox(opts.db, { status: 'unassigned' });
    return reply.send({ items: items.map(inboxView) });
  });

  /** Upload with NO character. The point of the whole inbox. */
  app.post('/admin/content/inbox', adminOnly, async (request, reply) => {
    if (!opts.uploadStorage) return storageUnavailable(reply);

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'invalid_request', message: 'A file part is required.' });
    }
    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({
        error: 'file_too_large',
        message: `That file exceeds the ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
      });
    }
    try {
      const item = await createInboxItem(opts.db, opts.uploadStorage, {
        mimeType: file.mimetype,
        bytes,
        originalName: file.filename,
        uploadedBy: request.currentUser?.id,
      });
      return reply.code(201).send(inboxView(item));
    } catch (err) {
      if (err instanceof ContentInboxError) {
        return reply.code(400).send({ error: err.kind, message: err.message });
      }
      throw err;
    }
  });

  /** Streams an inbox file. Admin-only and containment-checked, like uploads. */
  app.get<{ Params: { inboxId: string } }>(
    '/admin/content/inbox/:inboxId/file',
    adminOnly,
    async (request, reply) => {
      if (!opts.uploadStorage) return storageUnavailable(reply);
      const { inboxId } = request.params;
      if (!UUID_RE.test(inboxId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Upload not found.' });
      }
      const item = await getInboxItem(opts.db, inboxId);
      const path = item ? inboxPathOf(opts.uploadStorage, item) : null;
      if (!item || !path || !existsSync(path)) {
        return reply.code(404).send({ error: 'not_found', message: 'Upload not found.' });
      }
      reply.header('content-type', item.mimeType);
      reply.header('cache-control', 'private, max-age=60');
      return reply.send(createReadStream(path));
    },
  );

  /** Assign to a character and (optionally) a configured requirement. */
  app.post<{
    Params: { inboxId: string };
    Body: { characterId?: string; requirementKey?: string | null; contentRating?: string };
  }>('/admin/content/inbox/:inboxId/assign', adminOnly, async (request, reply) => {
    if (!opts.uploadStorage) return storageUnavailable(reply);
    const { inboxId } = request.params;
    if (!UUID_RE.test(inboxId)) {
      return reply.code(404).send({ error: 'not_found', message: 'Upload not found.' });
    }
    const characterId = request.body?.characterId;
    if (typeof characterId !== 'string' || !UUID_RE.test(characterId)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'characterId must be a character UUID.' });
    }
    if (!(await getCharacterForAdmin(opts.db, characterId))) {
      return reply.code(404).send({ error: 'not_found', message: 'Character not found.' });
    }
    const item = await getInboxItem(opts.db, inboxId);
    if (!item) return reply.code(404).send({ error: 'not_found', message: 'Upload not found.' });
    const requested = await resolveRequirementKey(
      request.body?.requirementKey,
      item.mediaType as MediaType,
    );
    if (!requested.ok) return refuseKey(reply, requested);

    const rating = request.body?.contentRating;
    if (rating !== undefined && !RATINGS.includes(rating as ContentRating)) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'contentRating must be sfw or explicit.' });
    }

    try {
      const { item, asset } = await assignInboxItem(opts.db, opts.uploadStorage, {
        inboxId,
        characterId,
        requirementKey: requested.key,
        contentRating: rating as ContentRating | undefined,
        assignedBy: request.currentUser?.id,
      });
      return reply.send({
        item: inboxView(item),
        // The new asset is under_review — assignment is intake, not approval.
        asset: assetView(await getReviewAsset(opts.db, asset.id)),
      });
    } catch (err) {
      if (err instanceof ContentInboxError) {
        return reply
          .code(err.kind === 'not_found' ? 404 : err.kind === 'already_resolved' ? 409 : 400)
          .send({ error: err.kind, message: err.message });
      }
      if (err instanceof LibraryUploadError) {
        return reply.code(400).send({ error: err.kind, message: err.message });
      }
      throw err;
    }
  });

  /** Discards an unassigned upload. The intake record survives; the bytes go. */
  app.post<{ Params: { inboxId: string } }>(
    '/admin/content/inbox/:inboxId/discard',
    adminOnly,
    async (request, reply) => {
      if (!opts.uploadStorage) return storageUnavailable(reply);
      const { inboxId } = request.params;
      if (!UUID_RE.test(inboxId)) {
        return reply.code(404).send({ error: 'not_found', message: 'Upload not found.' });
      }
      try {
        return reply.send(inboxView(await discardInboxItem(opts.db, opts.uploadStorage, inboxId)));
      } catch (err) {
        if (err instanceof ContentInboxError) {
          return reply
            .code(err.kind === 'not_found' ? 404 : 409)
            .send({ error: err.kind, message: err.message });
        }
        throw err;
      }
    },
  );

  /** The queue itself, newest first, optionally scoped to one character. */
  app.get<{ Querystring: { characterId?: string; status?: string; mediaType?: string } }>(
    '/admin/content/review',
    adminOnly,
    async (request, reply) => {
      const q = request.query;
      const assets = await listReviewQueue(opts.db, {
        characterId: q.characterId,
        status: q.status as VisualAssetStatus | undefined,
        mediaType: q.mediaType as MediaType | undefined,
      });
      return reply.send({ assets: assets.map(assetView) });
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId',
    adminOnly,
    async (request, reply) => {
      const view = assetView(await getReviewAsset(opts.db, request.params.assetId));
      if (!view) return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      return reply.send(view);
    },
  );

  app.post<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/approve',
    adminOnly,
    async (request, reply) => {
      try {
        await approveVisualAsset(opts.db, request.params.assetId, request.currentUser?.id);
        return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
      } catch (err) {
        if (err instanceof VisualAssetNotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
        }
        if (err instanceof VisualAssetTransitionError) {
          return reply.code(409).send({ error: 'invalid_transition', message: err.message });
        }
        throw err;
      }
    },
  );

  /**
   * RELEASE to the character's Posts tab, and take it back.
   *
   * A SEPARATE ACT FROM APPROVAL, deliberately. Approve says the content passed
   * moderation and exposes nothing; this says it may appear on her page. That
   * separation is what lets an operator hold approved content back, and pull a
   * live clip without rejecting or deleting it.
   *
   * Two verbs on one path rather than a PATCH with a boolean body, matching the
   * approve/reject pair directly above: the audit trail then reads as the
   * decision that was made, not as a field that was set.
   *
   * The service refuses to publish anything unapproved, and anything that is
   * not content — a reference portrait or chat media cannot become a post.
   */
  for (const [verb, published] of [
    ['publish', true],
    ['unpublish', false],
  ] as const) {
    app.post<{ Params: { assetId: string } }>(
      `/admin/content/assets/:assetId/${verb}`,
      adminOnly,
      async (request, reply) => {
        try {
          await setAssetPublished(opts.db, request.params.assetId, published);
          return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
        } catch (err) {
          if (err instanceof VisualAssetNotFoundError) {
            return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
          }
          if (err instanceof VisualAssetTransitionError) {
            return reply.code(409).send({ error: 'invalid_transition', message: err.message });
          }
          throw err;
        }
      },
    );
  }

  /**
   * Reject === the operator's "remove". The row, its provenance and its media
   * are preserved; only the lifecycle status changes. There is deliberately no
   * hard-delete endpoint.
   */
  app.post<{ Params: { assetId: string } }>(
    '/admin/content/assets/:assetId/reject',
    adminOnly,
    async (request, reply) => {
      try {
        await rejectVisualAsset(opts.db, request.params.assetId);
        return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
      } catch (err) {
        if (err instanceof VisualAssetNotFoundError) {
          return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
        }
        throw err;
      }
    },
  );

  /** Narrow metadata edit. Unsupported fields are refused, not ignored. */
  app.patch<{ Params: { assetId: string }; Body: Record<string, unknown> }>(
    '/admin/content/assets/:assetId',
    adminOnly,
    async (request, reply) => {
      const body = request.body ?? {};
      // requirementKey joins the narrow allow-list: filing an item under a
      // category IS a review decision, and it is the only way the board can be
      // populated by hand. Everything else on the row stays provenance or
      // lifecycle state that review must not rewrite.
      const allowed = new Set(['contentRating', 'position', 'requirementKey']);
      const unsupported = Object.keys(body).filter((k) => !allowed.has(k));
      if (unsupported.length > 0) {
        return reply.code(400).send({
          error: 'unsupported_field',
          message: `Not editable in review: ${unsupported.join(', ')}.`,
          supported: [...allowed],
        });
      }
      if (body.contentRating !== undefined && !RATINGS.includes(body.contentRating as ContentRating)) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'contentRating must be sfw or explicit.' });
      }

      let requirementKey: string | null | undefined;
      if ('requirementKey' in body) {
        const asset = await getReviewAsset(opts.db, request.params.assetId);
        if (!asset) return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
        const requested = await resolveRequirementKey(body.requirementKey, asset.mediaType);
        if (!requested.ok) return refuseKey(reply, requested);
        requirementKey = requested.key;
      }

      const updated = await updateAssetMetadata(opts.db, request.params.assetId, {
        contentRating: body.contentRating as ContentRating | undefined,
        position: body.position as number | null | undefined,
        requirementKey,
      });
      if (!updated) return reply.code(404).send({ error: 'not_found', message: 'Asset not found.' });
      return reply.send(assetView(await getReviewAsset(opts.db, request.params.assetId)));
    },
  );
}
