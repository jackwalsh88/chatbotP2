import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { characterVisualAssets, type CharacterVisualAssetRow } from '../db/schema.js';
import { codecLabel, inspectVideoCodec } from './video-codec.js';
import {
  activateVisualIdentityVersion,
  createVisualIdentityVersion,
  getActiveVisualIdentity,
} from './visual-identity-service.js';
import {
  approveVisualAsset,
  createVisualAsset,
  getVisualAssetById,
  type ContentRating,
} from './visual-asset-service.js';

/**
 * Manual Library upload (images and video).
 *
 * This is NOT generation and shares nothing with the media-generation pipeline:
 * no provider, no model, no cost ledger, no job, no prompt. The operator picks
 * a file that already exists; the server validates it, writes the bytes, and
 * records the asset through the SAME services generation uses — createVisualAsset
 * then approveVisualAsset — so no second lifecycle is introduced.
 *
 * Deliberate constraints, all inherited rather than invented:
 *  - character_id / visual_identity_id are NOT NULL on character_visual_assets,
 *    so an upload MUST name a character; the row attaches to that character's
 *    ACTIVE visual identity. There is no implicit or default character.
 *  - is_canonical stays FALSE. createVisualAsset never sets it, and
 *    approveVisualAsset promotes only kind='reference' — an upload is
 *    kind='generated', so it can never enter the public canonical gallery,
 *    whose filter is kind='reference' AND status='approved' AND is_canonical.
 *  - kind='generated' + status='approved' is exactly what the Library selects
 *    (LIBRARY_STATUSES in content-review-service). 'approved' here means "an
 *    admin chose this file", which is the same trust level the queue confers.
 *
 * STORAGE DURABILITY: bytes are written under MEDIA_STORAGE_DIR. On Railway
 * that must point at a mounted volume or uploads are lost on the next deploy —
 * the same ephemeral-filesystem caveat the internal media routes already carry.
 */

/** Accepted upload types, keyed by MIME, with the extension we store. */
const ACCEPTED: Record<string, { ext: string; media: 'image' | 'video' }> = {
  'image/jpeg': { ext: 'jpg', media: 'image' },
  'image/png': { ext: 'png', media: 'image' },
  'image/webp': { ext: 'webp', media: 'image' },
  'video/mp4': { ext: 'mp4', media: 'video' },
  'video/webm': { ext: 'webm', media: 'video' },
  'video/quicktime': { ext: 'mov', media: 'video' },
};

export const ACCEPTED_MIME_TYPES = Object.keys(ACCEPTED);

/**
 * 'image' | 'video' for an accepted MIME type, else null. Exported so callers
 * can reject a file BEFORE creating any database rows, rather than discovering
 * the problem half-way through a multi-step operation.
 */
export function acceptedMediaTypeOf(mimeType: string): 'image' | 'video' | null {
  return ACCEPTED[mimeType]?.media ?? null;
}

/** The extension this MIME type is stored with, or null if unsupported. */
export function acceptedExtensionOf(mimeType: string): string | null {
  return ACCEPTED[mimeType]?.ext ?? null;
}

export type LibraryUploadErrorKind =
  | 'unsupported_type'
  | 'unsupported_codec'
  | 'empty_file'
  | 'no_active_identity';

export class LibraryUploadError extends Error {
  constructor(
    public readonly kind: LibraryUploadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LibraryUploadError';
  }
}

export interface LibraryUploadInput {
  characterId: string;
  /** MIME type reported by the client; validated against ACCEPTED. */
  mimeType: string;
  bytes: Buffer;
  /** Original filename, recorded in provenance for traceability only. */
  originalName?: string;
  contentRating?: ContentRating;
  /** Admin user id, recorded as the approver of this manual addition. */
  uploadedBy?: string;
  /**
   * US-101. 'generated' (the default, and every pre-existing caller) is an
   * ordinary Library item. 'reference' makes this a PRIMARY REFERENCE for the
   * character's visual identity: approveVisualAsset promotes only references
   * to canonical, so the same upload path produces the identity's reference
   * set without a second storage mechanism or a duplicated file.
   *
   * 'chat' is Chat Content: media a character may send inside a private
   * conversation and nowhere else. It is excluded from every public surface by
   * `PUBLIC_CONTENT_KINDS` / `PUBLICLY_REACHABLE_KINDS`, and it is the ONLY
   * pool the chat selector reads. Callers never take this value from a
   * request body — the route derives it from the Character-page section.
   */
  kind?: 'reference' | 'generated' | 'chat';
  /**
   * Which identity VERSION this asset belongs to. Defaults to the character's
   * active identity (the pre-existing behaviour). Naming it explicitly is what
   * lets a reference be attached to a draft version before it is activated.
   */
  visualIdentityId?: string;
  /**
   * Optional label tying this asset to a content requirement. Passed straight
   * through, never defaulted: until the requirements model exists there is no
   * correct default, and inventing one here would hard-code a vocabulary the
   * next slice has to undo.
   */
  requirementKey?: string | null;
  /**
   * Whether this upload is approved on arrival.
   *
   * FALSE is the content path: the asset lands in `under_review` and an
   * operator decides in Review, which is what "manual upload and generated
   * content share one workflow" actually requires.
   *
   * TRUE — the default, and every pre-existing caller — is the IDENTITY path:
   * a primary reference an admin chose deliberately, where approval is the act
   * of choosing it and canonical promotion is the point. Defaulting to true
   * keeps that behaviour byte-for-byte unchanged.
   */
  approve?: boolean;
  /**
   * Whether this upload is RELEASED to the character's public Posts tab.
   *
   * FALSE is the default and every pre-existing caller: the Content Library and
   * the inbox both land content that an operator has not yet chosen to put on
   * anyone's page, so nothing this path creates becomes public by itself.
   *
   * TRUE is the Character page's Regular and Explicit shelves. That upload
   * already approves on arrival because "uploading to a character IS the
   * editorial decision" — this simply RECORDS the other half of that decision
   * instead of leaving it implied. It is the same operator action at the same
   * moment, not a second publishing mechanism.
   *
   * Publishing without approving is refused below rather than silently
   * corrected: content that has not passed moderation must never carry a
   * release time, or a later approval would put it live retroactively.
   */
  publish?: boolean;
}

export interface LibraryUploadStorage {
  /** Root directory uploaded bytes are written under (MEDIA_STORAGE_DIR). */
  storageDir: string;
  /**
   * API path prefix serving an uploaded asset's bytes. storage_key becomes
   * `${servePathPrefix}/<assetId>/file`, which the admin UI renders directly.
   */
  servePathPrefix: string;
}

/** Server-side absolute path of an uploaded asset, or null if not an upload. */
export function uploadedPathOf(asset: CharacterVisualAssetRow): string | null {
  const provenance = asset.provenance as Record<string, unknown>;
  if (provenance.source !== 'manual-upload') return null;
  const path = provenance.storagePath;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * The VERIFIED optimised derivative of an uploaded asset, or null.
 *
 * A SECOND FILE, NEVER A REPLACEMENT. `provenance.storagePath` keeps pointing
 * at the operator's original for the whole life of the asset; this key names an
 * ADDITIONAL file sitting beside it. Nothing in the upload path or the media
 * routes rewrites the original, so "serve the derivative" and "serve the
 * original" both remain available at every moment.
 *
 * ITS PRESENCE IS THE READY FLAG. It is written only after every check in the
 * verifier has passed against the bytes actually on disk. There is deliberately
 * no separate status column to fall out of step with the file: if the key is
 * here a verified file was written, and if it is absent the original serves.
 *
 * Reading it does NOT mean it will be served. `resolveMediaFile` consults
 * MEDIA_OPTIMISED_ENABLED first and re-checks that the file is still there.
 */
export function optimisedPathOf(asset: CharacterVisualAssetRow): string | null {
  const provenance = asset.provenance as Record<string, unknown>;
  if (provenance.source !== 'manual-upload') return null;
  const path = provenance.optimisedPath;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** Stored MIME type of an uploaded asset, for the serving route's header. */
export function uploadedMimeTypeOf(asset: CharacterVisualAssetRow): string {
  const mime = (asset.provenance as Record<string, unknown>).mimeType;
  return typeof mime === 'string' && mime.length > 0 ? mime : 'application/octet-stream';
}

/**
 * Gives a character its first visual identity version so an upload has
 * something to attach to.
 *
 * WHY THIS EXISTS. `character_visual_assets.visual_identity_id` is NOT NULL, so
 * every asset belongs to a version. Requiring the operator to author Visual DNA
 * before they may upload a single clip inverted the real workflow: media
 * arrives first, and the DNA describing the character is written later, if at
 * all. Uploading used to fail outright with `no_active_identity`.
 *
 * WHY IT IS NOT A NEW CONCEPT. This is exactly what character quick-create
 * already does (routes/admin-characters.ts) — v1 carrying only the one
 * attribute the validator requires, then activated. Reusing that keeps one
 * definition of "a character's first identity" and needs no schema change.
 *
 * WHY IT INVENTS NOTHING. `apparentAgeBand: 'adult'` is the sole field, and it
 * is the validator's own hard requirement, not a guess about appearance. Every
 * descriptive attribute stays absent until an operator writes it.
 */
async function provisionInitialIdentity(db: Db, characterId: string) {
  const created = await createVisualIdentityVersion(
    db,
    characterId,
    { apparentAgeBand: 'adult' },
    { label: 'Initial identity' },
  );
  return activateVisualIdentityVersion(db, created.id);
}

/**
 * Validates, stores and records one manually uploaded file.
 *
 * Order matters: the row is created BEFORE the bytes are written so the file is
 * named by the asset's own id, and storage_key is set only once the file is
 * safely on disk. An interrupted upload therefore leaves a keyless, unapproved
 * row — which the Library skips — never a row pointing at a missing file.
 */
export async function uploadLibraryAsset(
  db: Db,
  storage: LibraryUploadStorage,
  input: LibraryUploadInput,
): Promise<CharacterVisualAssetRow> {
  const accepted = ACCEPTED[input.mimeType];
  if (!accepted) {
    throw new LibraryUploadError(
      'unsupported_type',
      `Unsupported file type "${input.mimeType}". Accepted: ${ACCEPTED_MIME_TYPES.join(', ')}.`,
    );
  }
  if (input.bytes.length === 0) {
    throw new LibraryUploadError('empty_file', 'The selected file is empty.');
  }

  /**
   * THE CONTAINER IS NOT THE CODEC. An HEVC/H.265 file declares itself
   * `video/mp4` and sails past the check above, then fails to decode in Chrome
   * on Android and most desktop Chrome — an operator sees a working clip, a
   * visitor sees a tile that never starts. Caught here, at the moment of
   * upload, rather than becoming a published asset nobody can watch.
   *
   * Reads the bytes already in memory; it does NOT shell out to ffprobe, which
   * the API image does not ship. Anything unrecognised or unparseable is
   * allowed through unchanged — this only rejects a codec it positively
   * identified as unplayable.
   */
  if (accepted.media === 'video') {
    const { unsupported } = inspectVideoCodec(input.bytes, input.mimeType);
    if (unsupported.length > 0) {
      const names = unsupported.map(codecLabel).join(', ');
      throw new LibraryUploadError(
        'unsupported_codec',
        `This video uses ${names}, which most browsers cannot play. Re-export it as H.264 (or VP9/AV1) and upload again.`,
      );
    }
  }

  // An upload attaches to a specific identity VERSION. Unless one is named it
  // is the character's ACTIVE version — the pre-existing behaviour, and the
  // version the rest of the visual system treats as current.
  let visualIdentityId = input.visualIdentityId;
  if (!visualIdentityId) {
    const identity =
      (await getActiveVisualIdentity(db, input.characterId)) ??
      (await provisionInitialIdentity(db, input.characterId));
    visualIdentityId = identity.id;
  }

  const approve = input.approve ?? true;
  const created = await createVisualAsset(db, {
    characterId: input.characterId,
    visualIdentityId,
    // createVisualAsset enforces that the version belongs to this character,
    // so a mismatched pair is rejected rather than silently cross-linked.
    kind: input.kind ?? 'generated',
    // An unapproved upload joins the review queue in the SAME state generated
    // content arrives in, so one queue serves both origins.
    status: approve ? undefined : 'under_review',
    contentRating: input.contentRating ?? 'sfw',
    requirementKey: input.requirementKey ?? null,
    provenance: {
      source: 'manual-upload',
      originalName: input.originalName ?? null,
      mimeType: input.mimeType,
      mediaType: accepted.media,
      byteSize: input.bytes.length,
    },
  });

  const storagePath = join(
    storage.storageDir,
    input.characterId,
    'uploads',
    `${created.id}.${accepted.ext}`,
  );
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, input.bytes);

  await db
    .update(characterVisualAssets)
    .set({
      storageKey: `${storage.servePathPrefix}/${created.id}/file`,
      provenance: { ...(created.provenance as Record<string, unknown>), storagePath },
      updatedAt: new Date(),
    })
    .where(eq(characterVisualAssets.id, created.id));

  /**
   * RELEASE, recorded at the moment the operator made the decision.
   *
   * Guarded on `approve` as well as `publish`: an unapproved row must never
   * carry a release time, because approving it later would then put it live
   * without anyone choosing to. The two flags travel together from the shelf,
   * so this only ever refuses a caller that asked for something incoherent.
   */
  if (approve && input.publish) {
    await db
      .update(characterVisualAssets)
      .set({ publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(characterVisualAssets.id, created.id));
  }

  // Reuse the existing approval transition rather than inventing one: it records
  // approvedBy/approvedAt and leaves is_canonical false for a generated asset.
  if (approve) return approveVisualAsset(db, created.id, input.uploadedBy);

  // Not approved: return the row as it now stands, with its storage key set.
  const stored = await getVisualAssetById(db, created.id);
  return stored!;
}

/**
 * Permanently removes a Library asset: its row AND the file it owns.
 *
 * NOTE ON THE EXISTING DESIGN. admin-content.ts documents "remove" as a
 * REJECT, never a delete, so provenance survives. That remains true for the
 * review queue. This is a separate, explicitly-requested Library operation for
 * getting rid of content outright, and it is deliberately narrow:
 *
 *  - a CANONICAL asset is REFUSED. Canonical is the public gallery's
 *    membership test, so the public surface can never be altered from here.
 *  - the file is unlinked only when its recorded path resolves INSIDE
 *    MEDIA_STORAGE_DIR. A path outside it is left untouched — a stray or
 *    hand-edited provenance value can never make this delete arbitrary files.
 *  - a missing file is NOT an error. The row is still removed, so a Library
 *    entry orphaned by an ephemeral-disk redeploy can always be cleaned up.
 *  - no schema and no lifecycle enum is involved; the row is simply gone.
 *
 * generation_results.asset_id references this table with ON DELETE SET NULL,
 * so deleting an asset never cascades into generation history — the result row
 * survives with a null asset link.
 */
export class LibraryDeleteError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'canonical_refused',
    message: string,
  ) {
    super(message);
    this.name = 'LibraryDeleteError';
  }
}

export interface LibraryDeleteResult {
  assetId: string;
  fileRemoved: boolean;
  /** True when the row had a file path recorded but nothing was on disk. */
  fileWasMissing: boolean;
}

/** True only when `candidate` sits inside `root` (no traversal, no siblings). */
function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export async function deleteLibraryAsset(
  db: Db,
  storage: Pick<LibraryUploadStorage, 'storageDir'>,
  assetId: string,
): Promise<LibraryDeleteResult> {
  const asset = await getVisualAssetById(db, assetId);
  if (!asset) {
    throw new LibraryDeleteError('not_found', 'Asset not found.');
  }
  if (asset.isCanonical) {
    throw new LibraryDeleteError(
      'canonical_refused',
      'This asset is Primary (canonical) and is part of the public gallery. Remove it from Primary before deleting.',
    );
  }

  const recorded = (asset.provenance as Record<string, unknown>).storagePath;
  const path = typeof recorded === 'string' && recorded.length > 0 ? recorded : null;

  let fileRemoved = false;
  let fileWasMissing = false;
  if (path && isInside(storage.storageDir, path)) {
    // Check first: rm({force:true}) silently succeeds on a missing file, so it
    // cannot by itself tell "deleted" from "was never there" — and the caller
    // needs that distinction to report an orphaned row honestly.
    const existed = await stat(path).then(
      () => true,
      () => false,
    );
    if (existed) {
      await rm(path, { force: true });
      fileRemoved = true;
    } else {
      fileWasMissing = true;
    }
  } else if (path) {
    fileWasMissing = true; // outside the storage root: deliberately untouched
  }

  // The row goes last: if the unlink throws unexpectedly, the row survives and
  // the operation can be retried rather than leaving an unreachable file.
  await db.delete(characterVisualAssets).where(eq(characterVisualAssets.id, assetId));

  return { assetId, fileRemoved, fileWasMissing };
}
