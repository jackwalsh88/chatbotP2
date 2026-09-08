import { and, desc, eq } from 'drizzle-orm';
import type { VisualDna } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  characterVisualIdentities,
  type CharacterVisualIdentityRow,
} from '../db/schema.js';

/**
 * Visual Identity service (US-16A).
 *
 * Framework-agnostic pure functions over a Db handle, following the
 * character-/memory-service pattern. Owns the versioned Visual DNA of a
 * character:
 *  - validation (identity-only Visual DNA; adult-required)
 *  - version creation (immutable; new versions start as `draft`)
 *  - activation / retirement / rollback (transactional; exactly one active)
 *  - active-version resolution and history
 *
 * No image generation, provider, storage, or endpoint concerns live here.
 */

/** Thrown when Visual DNA fails validation. */
export class VisualDnaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisualDnaValidationError';
  }
}

/** Thrown when a referenced identity version does not exist. */
export class VisualIdentityNotFoundError extends Error {
  constructor(message = 'Visual identity version not found.') {
    super(message);
    this.name = 'VisualIdentityNotFoundError';
  }
}

/**
 * PRESENTATION attributes must never appear inside Visual DNA — they are a
 * generation-time concern recorded in a generated asset's provenance. This
 * list is the identity-vs-presentation boundary, enforced structurally.
 */
const PRESENTATION_KEYS = new Set([
  'hairstyle',
  'makeup',
  'clothing',
  'accessories',
  'pose',
  'expression',
  'environment',
  'lighting',
  'camera',
  'composition',
  'photographicstyle',
]);

/** Terms that unambiguously denote a minor — always rejected. */
const MINOR_TERMS = [
  'child',
  'children',
  'minor',
  'teen',
  'teenager',
  'adolescent',
  'underage',
  'under-age',
  'kid',
  'infant',
  'baby',
  'toddler',
  'preteen',
  'pre-teen',
  'prepubescent',
  'schoolgirl',
  'schoolboy',
  'high school',
  'high schooler',
  'middle school',
  'loli',
  'shota',
];

/**
 * Does `raw` contain a term that unambiguously denotes a minor? A lighter
 * check than isAdultAgeBand below: it rejects the negative case only, with no
 * requirement that the text also carry a positive adult signal. Used for
 * fields that are free descriptive text rather than an age band — e.g.
 * CharacterPersona's `lifeStage` ("college student", "renting with two
 * roommates") — where demanding an explicit "adult"/"20s"/numeric marker
 * would reject the overwhelming majority of legitimate values.
 */
export function containsMinorTerm(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return MINOR_TERMS.some((term) => value.includes(term));
}

/**
 * Adult-required check for `apparentAgeBand`. Conservative: unknown/ambiguous
 * values are rejected. This is a structural validation guard, NOT a policy or
 * moderation system.
 */
export function isAdultAgeBand(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  if (MINOR_TERMS.some((term) => value.includes(term))) return false;
  // Any explicit number below 18 disqualifies (e.g. "17", "16-19").
  const numbers = value.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.some((n) => n < 18)) return false;
  // Accept when it says adult, is a recognised adult band, or carries an age ≥ 18.
  if (value.includes('adult')) return true;
  if (/(mature|middle-aged|elderly|senior|grown)/.test(value)) return true;
  if (numbers.length > 0 && numbers.every((n) => n >= 18)) return true;
  // e.g. "20s", "30s"
  if (/\b([2-9]\d)s\b/.test(value)) return true;
  return false;
}

/**
 * Validates a Visual DNA payload. Deliberately permissive about attribute
 * SHAPES (the taxonomy is unproven) while enforcing the two firm rules:
 *  1. `apparentAgeBand` present and adult.
 *  2. No presentation attributes present.
 * Throws VisualDnaValidationError on failure.
 */
export function validateVisualDna(dna: unknown): asserts dna is VisualDna {
  if (typeof dna !== 'object' || dna === null || Array.isArray(dna)) {
    throw new VisualDnaValidationError('Visual DNA must be a JSON object.');
  }
  const record = dna as Record<string, unknown>;

  const age = record.apparentAgeBand;
  if (typeof age !== 'string' || age.trim().length === 0) {
    throw new VisualDnaValidationError('Visual DNA requires a non-empty apparentAgeBand.');
  }
  if (!isAdultAgeBand(age)) {
    throw new VisualDnaValidationError(
      'apparentAgeBand must denote an adult; non-adult or ambiguous values are rejected.',
    );
  }

  for (const key of Object.keys(record)) {
    if (PRESENTATION_KEYS.has(key.toLowerCase())) {
      throw new VisualDnaValidationError(
        `Visual DNA must not contain presentation attribute "${key}" — presentation is a generation-time concern.`,
      );
    }
  }
}

export interface CreateVisualIdentityOptions {
  label?: string;
}

/**
 * Creates a new visual identity version for a character. Validates the Visual
 * DNA, assigns the next sequential version number, and inserts it as `draft`.
 * Never overwrites an existing version. Version assignment + insert run in one
 * transaction so the (character_id, version) unique constraint is race-safe.
 */
export async function createVisualIdentityVersion(
  db: Db,
  characterId: string,
  visualDna: VisualDna,
  options: CreateVisualIdentityOptions = {},
): Promise<CharacterVisualIdentityRow> {
  validateVisualDna(visualDna);

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: characterVisualIdentities.version })
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.characterId, characterId))
      .orderBy(desc(characterVisualIdentities.version))
      .limit(1);

    const nextVersion = (latest?.version ?? 0) + 1;

    const [row] = await tx
      .insert(characterVisualIdentities)
      .values({
        characterId,
        version: nextVersion,
        status: 'draft',
        visualDna,
        label: options.label ?? null,
      })
      .returning();

    return row!;
  });
}

/** Sets a version active, retiring any currently-active version FIRST so the
 * partial-unique active constraint is never transiently violated. Idempotent
 * when the version is already active. Used by both activation and rollback. */
async function setActive(db: Db, identityId: string): Promise<CharacterVisualIdentityRow> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(characterVisualIdentities)
      .where(eq(characterVisualIdentities.id, identityId))
      .limit(1);
    if (!target) throw new VisualIdentityNotFoundError();
    if (target.status === 'active') return target;

    // Retire the current active version for this character (if any) first.
    await tx
      .update(characterVisualIdentities)
      .set({ status: 'retired', updatedAt: new Date() })
      .where(
        and(
          eq(characterVisualIdentities.characterId, target.characterId),
          eq(characterVisualIdentities.status, 'active'),
        ),
      );

    const [updated] = await tx
      .update(characterVisualIdentities)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(characterVisualIdentities.id, identityId))
      .returning();

    return updated!;
  });
}

/** Activates a version (draft/retired → active), transactionally retiring the
 * previous active version. */
export function activateVisualIdentityVersion(
  db: Db,
  identityId: string,
): Promise<CharacterVisualIdentityRow> {
  return setActive(db, identityId);
}

/** Rolls back to a previous (retired) version by re-activating it. Same
 * transactional guarantee as activation; the version's canonical reference set
 * returns with it because assets are bound to the identity version. */
export function rollbackToVisualIdentityVersion(
  db: Db,
  identityId: string,
): Promise<CharacterVisualIdentityRow> {
  return setActive(db, identityId);
}

/** Explicitly retires a version (e.g. an active one) without activating another. */
export async function retireVisualIdentityVersion(
  db: Db,
  identityId: string,
): Promise<CharacterVisualIdentityRow> {
  const [updated] = await db
    .update(characterVisualIdentities)
    .set({ status: 'retired', updatedAt: new Date() })
    .where(eq(characterVisualIdentities.id, identityId))
    .returning();
  if (!updated) throw new VisualIdentityNotFoundError();
  return updated;
}

/** The character's active visual identity version, or null if none is active. */
export async function getActiveVisualIdentity(
  db: Db,
  characterId: string,
): Promise<CharacterVisualIdentityRow | null> {
  const [row] = await db
    .select()
    .from(characterVisualIdentities)
    .where(
      and(
        eq(characterVisualIdentities.characterId, characterId),
        eq(characterVisualIdentities.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Full version history for a character, newest version first. */
export async function listVisualIdentityVersions(
  db: Db,
  characterId: string,
): Promise<CharacterVisualIdentityRow[]> {
  return db
    .select()
    .from(characterVisualIdentities)
    .where(eq(characterVisualIdentities.characterId, characterId))
    .orderBy(desc(characterVisualIdentities.version));
}

/** A single version by id, or null. */
export async function getVisualIdentityById(
  db: Db,
  identityId: string,
): Promise<CharacterVisualIdentityRow | null> {
  const [row] = await db
    .select()
    .from(characterVisualIdentities)
    .where(eq(characterVisualIdentities.id, identityId))
    .limit(1);
  return row ?? null;
}
