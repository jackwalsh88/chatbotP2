import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import type { Db } from '../db/client.js';
import {
  CharacterNameTakenError,
  CharacterValidationError,
  createCharacter,
  createCharacterDraft,
  getCharacterForAdmin,
  listAllCharacters,
  updateCharacter,
} from '../services/character-service.js';
import {
  ProfileAuthorError,
  unconfiguredProfileAuthor,
  type ProfileAuthor,
} from '../services/character-profile-service.js';
import { PersonaGeneratorError, unconfiguredPersonaGenerator, type PersonaGenerator } from '../services/character-persona-generator.js';
import {
  CharacterPersonaRegenerationError,
  CharacterPersonaValidationError,
  getCharacterPersona,
  regenerateCharacterPersona,
  saveCharacterPersona,
} from '../services/character-persona-service.js';
import {
  VisualDnaValidationError,
  VisualIdentityNotFoundError,
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
  getVisualIdentityById,
  listVisualIdentityVersions,
} from '../services/visual-identity-service.js';
import {
  VisualAssetNotFoundError,
  VisualAssetScopeError,
  VisualAssetTransitionError,
  approveVisualAsset,
  getVisualAssetById,
  listCanonicalReferences,
  listVisualAssets,
  rejectVisualAsset,
  setVisualAssetPosition,
} from '../services/visual-asset-service.js';
import {
  ACCEPTED_MIME_TYPES,
  LibraryUploadError,
  acceptedMediaTypeOf,
  uploadLibraryAsset,
  type LibraryUploadStorage,
} from '../services/library-upload-service.js';
import { listCharacterContent, mediaTypeOf } from '../services/content-review-service.js';
import {
  getContentRequirementByKey,
  getPrimaryReferenceRequirementKey,
} from '../services/content-requirements-service.js';
import {
  getRequirementStatus,
  planMissingContentFor,
} from '../services/requirement-status-service.js';
import type { CharacterVisualAssetRow, CharacterVisualIdentityRow } from '../db/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * US-101 — Character, Visual Identity and Primary Reference management.
 *
 * SCOPE BOUNDARY, deliberately hard: this module manages a character's
 * IDENTITY. It never approves or rejects generated content — that is the
 * review queue (US-106) and it lives in admin-content.ts. The only approval
 * that happens here is the one that makes an uploaded REFERENCE canonical,
 * which is an identity act, not a content-moderation act.
 *
 * Almost nothing here is new domain logic. Versioning, the one-active rule,
 * canonical promotion and asset scoping were all built in US-16A; this exposes
 * them over HTTP and adds the character writes that were missing. That is why
 * there is NO migration: `characters`, `character_visual_identities` (with its
 * partial unique index on one active version per character) and
 * `character_visual_assets.visual_identity_id` already model everything the
 * ticket asks for.
 *
 * Provider-agnostic by construction: nothing below mentions an image or video
 * generator. It records identity and references; generation reads them later.
 */

/** Wire shape for an identity version. Raw DNA is admin-visible by design. */
function identityView(row: CharacterVisualIdentityRow) {
  return {
    id: row.id,
    characterId: row.characterId,
    version: row.version,
    status: row.status,
    label: row.label,
    visualDna: row.visualDna,
    isActive: row.status === 'active',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Wire shape for a reference asset. Same discipline as everywhere else:
 * storage_key and provenance never reach the client, only an admin-authed
 * serving path it can render.
 */
function referenceView(row: CharacterVisualAssetRow) {
  return {
    assetId: row.id,
    characterId: row.characterId,
    visualIdentityId: row.visualIdentityId,
    kind: row.kind,
    status: row.status,
    isPrimary: row.isCanonical,
    position: row.position,
    contentRating: row.contentRating,
    mediaType: mediaTypeOf(row.storageKey, row.provenance),
    fileUrl: row.storageKey ? `/admin/content/uploads/${row.id}/file` : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default async function adminCharacterRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    uploadStorage: LibraryUploadStorage;
    profileAuthor?: ProfileAuthor;
    personaGenerator?: PersonaGenerator;
  },
) {
  const adminOnly = { preHandler: [app.requireAuth, app.requireAdmin] };
  // Default to the unconfigured author so an un-wired app fails honestly
  // ("Autofill unavailable") instead of silently having no route at all.
  const profileAuthor = opts.profileAuthor ?? unconfiguredProfileAuthor;
  // Same discipline for persona generation (Phase 2).
  const personaGenerator = opts.personaGenerator ?? unconfiguredPersonaGenerator;

  // Scoped to this plugin, mirroring admin-content.ts: multipart parsing is
  // registered only where uploads actually land.
  // Text fields are bounded too, not just the file: quick-create is the only
  // route here that reads any, and it needs a name and one short key.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8, fieldSize: 4096 },
  });

  /** One opaque 404 for every miss — no existence leaks between admins. */
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found', message: 'Not found.' });

  /* ---------------------------------------------------------------- *
   * Characters
   * ---------------------------------------------------------------- */

  app.get('/admin/characters', adminOnly, async () => {
    const characters = await listAllCharacters(opts.db);
    // Each row carries its identity summary so the list can show readiness
    // without the UI making N follow-up requests.
    return Promise.all(
      characters.map(async (character) => {
        const active = await getActiveVisualIdentity(opts.db, character.id);
        const versions = await listVisualIdentityVersions(opts.db, character.id);
        const primaryCount = active
          ? (await listCanonicalReferences(opts.db, character.id, active.id)).length
          : 0;
        return {
          ...character,
          activeIdentityVersion: active?.version ?? null,
          identityVersionCount: versions.length,
          primaryReferenceCount: primaryCount,
        };
      }),
    );
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/admin/characters',
    adminOnly,
    async (request, reply) => {
      try {
        const created = await createCharacter(opts.db, request.body as never);
        return reply.code(201).send(created);
      } catch (error) {
        if (error instanceof CharacterValidationError) {
          return reply
            .code(400)
            .send({ error: 'invalid_character', field: error.field, message: error.message });
        }
        if (error instanceof CharacterNameTakenError) {
          return reply.code(409).send({ error: 'name_taken', message: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Quick create: a name and one image is all it takes to have a character.
   *
   * This is the whole point of Phase 1 — an operator can get a character into
   * the system in seconds and fill in (or Autofill) the persona afterwards,
   * instead of writing five paragraphs before they can do anything.
   *
   * It composes existing operations rather than adding new ones:
   *   character draft → identity version 1 → activate → upload as a PRIMARY
   *   REFERENCE bound to that version.
   * The image is therefore represented by the existing identity/reference
   * system, stored once, with no second copy made to populate profile_image —
   * which stays null, and which every existing surface already falls back from.
   *
   * The file is fully validated BEFORE any row is written, so the common
   * failure (wrong file type) cannot leave a half-made character behind.
   */
  app.post('/admin/characters/quick', adminOnly, async (request, reply) => {
    if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'Expected a multipart upload.' });
    }

    // Read every part before doing anything: field order in a multipart body is
    // the client's choice, and reading fields off the file part would silently
    // miss any field sent after it.
    const fields: Record<string, string> = {};
    let file: { bytes: Buffer; mimeType: string; filename: string } | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer(); // must drain, even if ignored
          if (!file) file = { bytes, mimeType: part.mimetype, filename: part.filename };
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (error) {
      // A malformed body, an oversized file or too many parts is the client's
      // mistake, not a server fault: report it as one rather than a 500. The
      // plugin's own errors carry the right status (413 for a size limit).
      const status = (error as { statusCode?: number }).statusCode;
      return reply
        .code(typeof status === 'number' && status >= 400 && status < 500 ? status : 400)
        .send({ error: 'invalid_upload', message: 'That upload could not be read.' });
    }

    // A PHOTO IS OPTIONAL. Requiring one meant a character could not exist
    // until her media did, which is the wrong way round for an operator who
    // builds the roster first and uploads over the following days. Without a
    // file this creates the character alone; her first identity version is
    // provisioned on demand by the first upload, so nothing downstream needs
    // her to have had one now.
    if (file && acceptedMediaTypeOf(file.mimeType) !== 'image') {
      return reply.code(400).send({
        error: 'unsupported_type',
        message: `A primary reference must be an image. Accepted: ${ACCEPTED_MIME_TYPES.filter(
          (m) => acceptedMediaTypeOf(m) === 'image',
        ).join(', ')}.`,
      });
    }
    if (file && file.bytes.length === 0) {
      return reply.code(400).send({ error: 'empty_file', message: 'The selected file is empty.' });
    }

    // Which requirement this image satisfies.
    //
    // CONFIGURATION decides, not code. A caller may name a key explicitly;
    // otherwise we ask which requirement CLAIMS the primary reference — a flag
    // Settings owns. So the primary image counts toward its category on
    // creation without this file ever naming one, and re-pointing it (or
    // clearing it entirely) is a Settings change rather than a deploy.
    const requestedKey = fields.requirementKey?.trim().slice(0, 100);
    const requirementKey = requestedKey
      ? ((await getContentRequirementByKey(opts.db, requestedKey))?.key ?? null)
      : await getPrimaryReferenceRequirementKey(opts.db);

    let character;
    try {
      character = await createCharacterDraft(opts.db, {
        name: fields.name ?? '',
        displayName: fields.displayName,
      });
    } catch (error) {
      if (error instanceof CharacterValidationError) {
        return reply
          .code(400)
          .send({ error: 'invalid_character', field: error.field, message: error.message });
      }
      if (error instanceof CharacterNameTakenError) {
        return reply.code(409).send({ error: 'name_taken', message: error.message });
      }
      throw error;
    }

    // NO PHOTO: the character exists and that is the whole job. No identity
    // version is created here — the first upload provisions it, so an operator
    // who never adds a photo is not left with an empty version to explain.
    if (!file) {
      return reply.code(201).send({ character, identity: null, primaryReference: null });
    }

    // Version 1 carries only the one attribute the validator requires. The
    // visual DNA is the operator's to write later; guessing appearance from a
    // file we have not looked at would be fiction dressed up as data.
    const identity = await createVisualIdentityVersion(
      opts.db,
      character.id,
      { apparentAgeBand: 'adult' },
      { label: 'Initial identity' },
    );
    const active = await activateVisualIdentityVersion(opts.db, identity.id);

    try {
      const asset = await uploadLibraryAsset(opts.db, opts.uploadStorage, {
        characterId: character.id,
        visualIdentityId: active.id,
        kind: 'reference',
        requirementKey,
        mimeType: file.mimeType,
        bytes: file.bytes,
        originalName: file.filename,
        uploadedBy: request.currentUser!.id,
      });
      return reply.code(201).send({
        character,
        identity: identityView(active),
        primaryReference: referenceView(asset),
      });
    } catch (error) {
      // The file was validated above, so anything here is a real server-side
      // failure (disk, database). The character survives and the operator can
      // add the reference from its detail page rather than starting over.
      if (error instanceof LibraryUploadError || error instanceof VisualAssetScopeError) {
        return reply.code(400).send({ error: 'upload_failed', message: error.message });
      }
      throw error;
    }
  });

  /**
   * A character's required-content status: what she needs, has and lacks.
   *
   * Derived on every read from the configured requirements plus her actual
   * assets — no stored counters — so it reflects a Settings change immediately
   * and a configuration change can never have touched her content.
   */
  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/requirements',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);

      const status = await getRequirementStatus(opts.db, characterId);
      return {
        totals: status.totals,
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
        })),
        triageCount: status.triage.length,
      };
    },
  );

  /**
   * Everything this character has, on the character's own page.
   *
   * Assembled from tables that were already readable — it introduces no
   * lifecycle, no new state and no new permission, and every locator it emits
   * is the same opaque id-keyed admin route every other admin surface uses.
   * Its only job is to stop "what content does Maria have?" being a question
   * that requires visiting four screens.
   */
  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/content',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);
      return { assets: await listCharacterContent(opts.db, characterId) };
    },
  );

  /**
   * "What is missing?" — the plan a Generation Studio (US-104) or any future
   * automation submits as generation jobs.
   *
   * This is the SAME derivation the Review board renders, so a planner and the
   * board can never disagree, and it names no category or quantity of its own.
   * It is a read: nothing is generated, queued or spent here.
   */
  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/requirements/plan',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);
      return { missing: await planMissingContentFor(opts.db, characterId) };
    },
  );

  /**
   * Autofill — proposes a complete persona for an existing character.
   *
   * DRAFT ONLY. Nothing is written: the response is a candidate the operator
   * edits and saves with the ordinary PATCH above. Re-rolling therefore cannot
   * destroy work already done, and Autofill can never touch media, identity or
   * anything else it was not asked about.
   */
  app.post<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/autofill',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      const character = await getCharacterForAdmin(opts.db, characterId);
      if (!character) return notFound(reply);

      try {
        const draft = await profileAuthor({
          displayName: character.displayName,
          // Fresh per request, so "Autofill again" genuinely re-rolls. Generated
          // at the edge, keeping the service itself free of clocks and RNG.
          variationSeed: randomUUID(),
        });
        return { draft };
      } catch (error) {
        if (error instanceof ProfileAuthorError) {
          // Kind only — never a provider response body, endpoint or key.
          const status = error.kind === 'not_configured' ? 503 : 502;
          return reply.code(status).send({ error: `ai_${error.kind}`, message: error.message });
        }
        throw error;
      }
    },
  );

  /* ---------------------------------------------------------------- *
   * Avatar-derived persona (Phase 2)
   * ---------------------------------------------------------------- */

  /** The character's current persona, plus which fields an admin has edited by hand. */
  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/persona',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);

      const row = await getCharacterPersona(opts.db, characterId);
      return {
        persona: row?.persona ?? {},
        editedFields: row?.editedFields ?? [],
        sourceAssetId: row?.sourceAssetId ?? null,
        generatedAt: row?.generatedAt?.toISOString() ?? null,
      };
    },
  );

  /**
   * Admin edit. A PARTIAL persona: only the keys sent are validated and
   * merged in, and each becomes protected from being overwritten by a later
   * regeneration (see saveCharacterPersona).
   */
  app.patch<{ Params: { characterId: string }; Body: Record<string, unknown> }>(
    '/admin/characters/:characterId/persona',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);

      try {
        const row = await saveCharacterPersona(opts.db, characterId, request.body ?? {});
        return {
          persona: row.persona,
          editedFields: row.editedFields,
          sourceAssetId: row.sourceAssetId,
          generatedAt: row.generatedAt?.toISOString() ?? null,
        };
      } catch (error) {
        if (error instanceof CharacterPersonaValidationError) {
          return reply.code(400).send({ error: 'invalid_persona', message: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Re-analyses the character's current primary reference image and merges
   * the result into her persona. WRITES IMMEDIATELY (unlike Autofill's
   * draft-only flow) because the protection here is structural, not
   * procedural: regenerateCharacterPersona never overwrites a field already
   * in editedFields, and never touches the row at all on failure.
   */
  app.post<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/persona/regenerate',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      const character = await getCharacterForAdmin(opts.db, characterId);
      if (!character) return notFound(reply);

      try {
        const row = await regenerateCharacterPersona(
          opts.db,
          {
            displayName: character.displayName,
            shortBio: character.shortBio,
            personality: character.personality,
            interests: character.interests,
          },
          characterId,
          personaGenerator,
        );
        return {
          persona: row.persona,
          editedFields: row.editedFields,
          sourceAssetId: row.sourceAssetId,
          generatedAt: row.generatedAt?.toISOString() ?? null,
        };
      } catch (error) {
        // Kind only — never a provider response body, endpoint or key.
        if (error instanceof PersonaGeneratorError) {
          const status = error.kind === 'not_configured' ? 503 : 502;
          return reply.code(status).send({ error: `persona_${error.kind}`, message: error.message });
        }
        if (error instanceof CharacterPersonaRegenerationError) {
          const status = error.kind === 'no_source_image' ? 409 : 502;
          return reply.code(status).send({ error: `persona_${error.kind}`, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);

      const character = await getCharacterForAdmin(opts.db, characterId);
      if (!character) return notFound(reply);

      const versions = await listVisualIdentityVersions(opts.db, characterId);
      const active = versions.find((v) => v.status === 'active') ?? null;
      const primaryReferences = active
        ? await listCanonicalReferences(opts.db, characterId, active.id)
        : [];

      return {
        character,
        // Newest version first — the operator works at the head of the list.
        identities: [...versions].sort((a, b) => b.version - a.version).map(identityView),
        activeIdentity: active ? identityView(active) : null,
        primaryReferences: primaryReferences.map(referenceView),
      };
    },
  );

  app.patch<{ Params: { characterId: string }; Body: Record<string, unknown> }>(
    '/admin/characters/:characterId',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      try {
        const updated = await updateCharacter(opts.db, characterId, request.body as never);
        if (!updated) return notFound(reply);
        return updated;
      } catch (error) {
        if (error instanceof CharacterValidationError) {
          return reply
            .code(400)
            .send({ error: 'invalid_character', field: error.field, message: error.message });
        }
        if (error instanceof CharacterNameTakenError) {
          return reply.code(409).send({ error: 'name_taken', message: error.message });
        }
        throw error;
      }
    },
  );

  /* ---------------------------------------------------------------- *
   * Visual identity versions
   * ---------------------------------------------------------------- */

  app.get<{ Params: { characterId: string } }>(
    '/admin/characters/:characterId/identities',
    adminOnly,
    async (request, reply) => {
      const { characterId } = request.params;
      if (!UUID_RE.test(characterId)) return notFound(reply);
      if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);
      const versions = await listVisualIdentityVersions(opts.db, characterId);
      return [...versions].sort((a, b) => b.version - a.version).map(identityView);
    },
  );

  /**
   * Creates the NEXT version. Never edits an existing one — history is the
   * point of this screen, so "edit" is always "create a new version from
   * these attributes", optionally seeded from an existing version.
   */
  app.post<{
    Params: { characterId: string };
    Body: { visualDna?: unknown; label?: string; fromIdentityId?: string };
  }>('/admin/characters/:characterId/identities', adminOnly, async (request, reply) => {
    const { characterId } = request.params;
    if (!UUID_RE.test(characterId)) return notFound(reply);
    if (!(await getCharacterForAdmin(opts.db, characterId))) return notFound(reply);

    let visualDna = request.body?.visualDna;

    // Duplicate-as-new-version: seed from an existing version of THIS
    // character, so "edit the active identity" never mutates history.
    if (visualDna === undefined && request.body?.fromIdentityId) {
      const source = await getVisualIdentityById(opts.db, request.body.fromIdentityId);
      if (!source || source.characterId !== characterId) return notFound(reply);
      visualDna = source.visualDna;
    }

    try {
      const created = await createVisualIdentityVersion(
        opts.db,
        characterId,
        visualDna as never,
        { label: request.body?.label },
      );
      return reply.code(201).send(identityView(created));
    } catch (error) {
      if (error instanceof VisualDnaValidationError) {
        return reply.code(400).send({ error: 'invalid_visual_dna', message: error.message });
      }
      throw error;
    }
  });

  /**
   * Activation. The service retires the previous active version inside one
   * transaction, so the partial-unique index is never transiently violated and
   * the old version survives as history rather than being deleted.
   */
  app.post<{ Params: { identityId: string } }>(
    '/admin/identities/:identityId/activate',
    adminOnly,
    async (request, reply) => {
      const { identityId } = request.params;
      if (!UUID_RE.test(identityId)) return notFound(reply);
      try {
        return identityView(await activateVisualIdentityVersion(opts.db, identityId));
      } catch (error) {
        if (error instanceof VisualIdentityNotFoundError) return notFound(reply);
        throw error;
      }
    },
  );

  /* ---------------------------------------------------------------- *
   * Primary references
   *
   * A primary reference is not a new entity: it is
   *   kind='reference' AND status='approved' AND is_canonical
   * on a specific identity VERSION. That is the same rule the public gallery
   * already reads, so linking one here is what makes it visible downstream.
   * ---------------------------------------------------------------- */

  app.get<{ Params: { identityId: string } }>(
    '/admin/identities/:identityId/references',
    adminOnly,
    async (request, reply) => {
      const { identityId } = request.params;
      if (!UUID_RE.test(identityId)) return notFound(reply);
      const identity = await getVisualIdentityById(opts.db, identityId);
      if (!identity) return notFound(reply);
      const assets = await listVisualAssets(opts.db, identity.characterId, identityId, {
        kind: 'reference',
      });
      return assets.map(referenceView);
    },
  );

  /**
   * Uploads a file AND links it to this identity version as a primary
   * reference, in one step. Reuses the Library upload service, so there is one
   * storage path and one file on disk — nothing is copied or re-encoded.
   */
  app.post<{ Params: { identityId: string } }>(
    '/admin/identities/:identityId/references',
    adminOnly,
    async (request, reply) => {
      const { identityId } = request.params;
      if (!UUID_RE.test(identityId)) return notFound(reply);
      const identity = await getVisualIdentityById(opts.db, identityId);
      if (!identity) return notFound(reply);

      if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', message: 'Expected a multipart upload.' });
      }
      const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      if (!file) {
        return reply.code(400).send({ error: 'invalid_request', message: 'No file was provided.' });
      }
      const bytes = await file.toBuffer();

      try {
        const asset = await uploadLibraryAsset(
          opts.db,
          opts.uploadStorage,
          {
            characterId: identity.characterId,
            visualIdentityId: identityId,
            kind: 'reference',
            mimeType: file.mimetype,
            bytes,
            originalName: file.filename,
            uploadedBy: request.currentUser!.id,
          },
        );
        // uploadLibraryAsset approves it, and approveVisualAsset promotes ONLY
        // references to canonical — so this is already a primary reference.
        return reply.code(201).send(referenceView(asset));
      } catch (error) {
        if (error instanceof LibraryUploadError) {
          return reply.code(400).send({ error: error.kind, message: error.message });
        }
        if (error instanceof VisualAssetScopeError) {
          return reply.code(400).send({ error: 'scope_error', message: error.message });
        }
        throw error;
      }
    },
  );

  /** Promotes an EXISTING asset to primary for its own identity version. */
  app.post<{ Params: { assetId: string } }>(
    '/admin/references/:assetId/primary',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) return notFound(reply);
      const asset = await getVisualAssetById(opts.db, assetId);
      if (!asset) return notFound(reply);
      if (asset.kind !== 'reference') {
        return reply.code(400).send({
          error: 'not_a_reference',
          message: 'Only reference assets can be primary. Generated content belongs to the Library.',
        });
      }
      try {
        return referenceView(await approveVisualAsset(opts.db, assetId, request.currentUser!.id));
      } catch (error) {
        if (error instanceof VisualAssetNotFoundError) return notFound(reply);
        // A rejected asset cannot be re-promoted. That is the existing EPIC 7
        // rule; reporting it as a 409 with the reason beats a 500 that looks
        // like a bug to whoever clicked the button.
        if (error instanceof VisualAssetTransitionError) {
          return reply.code(409).send({ error: 'invalid_transition', message: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Removes a reference from the primary set. Reject is the existing
   * transition that clears is_canonical, and it keeps the row and its file —
   * so this un-links without destroying history or orphaning bytes.
   */
  app.delete<{ Params: { assetId: string } }>(
    '/admin/references/:assetId/primary',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) return notFound(reply);
      const asset = await getVisualAssetById(opts.db, assetId);
      if (!asset) return notFound(reply);
      try {
        return referenceView(await rejectVisualAsset(opts.db, assetId));
      } catch (error) {
        if (error instanceof VisualAssetNotFoundError) return notFound(reply);
        throw error;
      }
    },
  );

  /** Explicit ordering of the primary set (hero first). */
  app.patch<{ Params: { assetId: string }; Body: { position: number | null } }>(
    '/admin/references/:assetId/position',
    adminOnly,
    async (request, reply) => {
      const { assetId } = request.params;
      if (!UUID_RE.test(assetId)) return notFound(reply);
      try {
        const updated = await setVisualAssetPosition(
          opts.db,
          assetId,
          request.body?.position ?? null,
        );
        return referenceView(updated);
      } catch (error) {
        if (error instanceof VisualAssetNotFoundError) return notFound(reply);
        throw error;
      }
    },
  );
}
