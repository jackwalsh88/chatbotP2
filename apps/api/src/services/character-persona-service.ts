import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { CharacterPersona } from '@over18/shared';
import type { Db } from '../db/client.js';
import { characterPersonas, type CharacterPersonaRow } from '../db/schema.js';
import {
  containsMinorTerm,
  getActiveVisualIdentity,
  isAdultAgeBand,
} from './visual-identity-service.js';
import { listCanonicalReferences } from './visual-asset-service.js';
import { uploadedMimeTypeOf, uploadedPathOf } from './library-upload-service.js';
import type { PersonaGenerator } from './character-persona-generator.js';

/**
 * Persona validation + persistence (Phase 2 avatar-derived persona).
 *
 * Framework-agnostic pure functions over a Db handle, following the
 * character-/visual-identity-service pattern. Owns:
 *  - validation of a CharacterPersona payload (structural + adult-safety)
 *  - persistence of the CURRENT persona (generated fields + admin edits,
 *    already merged) and which fields an admin has explicitly written
 *  - regeneration orchestration: resolve the character's avatar, call the
 *    generator, merge the result in without touching admin-edited fields
 *
 * No vision/LLM concerns live here — those belong to
 * character-persona-generator.ts, injected as a PersonaGenerator function.
 */

export class CharacterPersonaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterPersonaValidationError';
  }
}

const MAX_SHORT_FIELD_CHARS = 200;
const MAX_LONG_FIELD_CHARS = 300;
const MAX_ARRAY_ITEMS = 6;
const MAX_ARRAY_ITEM_CHARS = 120;

/**
 * Strips control characters/newlines and collapses whitespace. Never throws.
 *
 * Built from character codes rather than a regex control-character class, so
 * there is no ambiguity about what gets matched: anything below U+0020
 * (space) or equal to U+007F (DEL) is dropped, everything else survives.
 */
function clean(value: string, maxChars: number): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanStringArray(value: unknown, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clean(item, maxChars))
    .filter((item) => item.length > 0)
    .slice(0, MAX_ARRAY_ITEMS);
}

/** Optional-string fields, cleaned and capped at MAX_SHORT_FIELD_CHARS. */
const SHORT_STRING_FIELDS = [
  'ageRange',
  'lifeStage',
  'occupation',
  'education',
  'visualStyle',
  'socialStyle',
  'humorStyle',
  'flirtingStyle',
  'speechRegister',
  'relationshipToWorkOrSchool',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/** Optional string-array fields, cleaned item-by-item. */
const ARRAY_FIELDS = [
  'demeanor',
  'interests',
  'hobbies',
  'dailyContext',
  'recurringConcerns',
  'backgroundNotes',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/**
 * Validates and normalises a persona payload. UNKNOWN KEYS ARE NEVER READ —
 * this function only ever accesses the named CharacterPersona properties, so
 * a hallucinated or hand-edited key (e.g. a sensitive-trait field this
 * product never asks for) simply has no path into the returned object. This
 * is the primary guard described in the Phase 2 handoff's privacy section.
 *
 * Partial by design: every field is optional, so this validates whatever
 * subset is present — used both for a full generated persona and for a
 * partial admin edit.
 *
 * Throws CharacterPersonaValidationError on a structural or adult-safety
 * violation; a field that is simply the wrong type or empty is silently
 * dropped rather than failing the whole payload (same tolerance the existing
 * Autofill validator applies to `interests`).
 */
export function validateCharacterPersona(value: unknown): CharacterPersona {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CharacterPersonaValidationError('Persona must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const out: CharacterPersona = {};

  if (record.age !== undefined) {
    const age = record.age;
    if (typeof age !== 'number' || !Number.isInteger(age)) {
      throw new CharacterPersonaValidationError('age must be an integer.');
    }
    if (age < 18) {
      throw new CharacterPersonaValidationError('age must denote an adult (18 or older).');
    }
    out.age = age;
  }

  for (const field of SHORT_STRING_FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const cleaned = clean(raw, MAX_SHORT_FIELD_CHARS);
    if (cleaned.length === 0) continue;
    if (field === 'ageRange' && !isAdultAgeBand(cleaned)) {
      throw new CharacterPersonaValidationError(
        'ageRange must denote an adult; non-adult or ambiguous values are rejected.',
      );
    }
    if (field === 'lifeStage' && containsMinorTerm(cleaned)) {
      throw new CharacterPersonaValidationError(
        'lifeStage must not denote a minor.',
      );
    }
    (out as Record<string, unknown>)[field] = cleaned;
  }

  if (typeof record.sourceSummary === 'string') {
    const cleaned = clean(record.sourceSummary, MAX_LONG_FIELD_CHARS);
    if (cleaned.length > 0) out.sourceSummary = cleaned;
  }

  for (const field of ARRAY_FIELDS) {
    const cleaned = cleanStringArray(record[field], MAX_ARRAY_ITEM_CHARS);
    if (cleaned.length > 0) (out as Record<string, unknown>)[field] = cleaned;
  }

  return out;
}

function dedupeFields(existing: string[], added: string[]): string[] {
  return Array.from(new Set([...existing, ...added]));
}

/** The current persona row for a character, or null if none exists yet. */
export async function getCharacterPersona(
  db: Db,
  characterId: string,
): Promise<CharacterPersonaRow | null> {
  const [row] = await db
    .select()
    .from(characterPersonas)
    .where(eq(characterPersonas.characterId, characterId))
    .limit(1);
  return row ?? null;
}

/**
 * Admin edit path. `edits` is a PARTIAL persona — only the keys present are
 * validated, merged onto the current persona, and recorded in `editedFields`
 * so a later regeneration knows to leave them alone. Upserts: a character
 * with no persona row yet gets one, seeded from `edits` alone.
 */
export async function saveCharacterPersona(
  db: Db,
  characterId: string,
  edits: Record<string, unknown>,
): Promise<CharacterPersonaRow> {
  const validated = validateCharacterPersona(edits);
  const editedKeys = Object.keys(validated);

  const existing = await getCharacterPersona(db, characterId);
  const persona: CharacterPersona = { ...(existing?.persona ?? {}), ...validated };
  const editedFields = dedupeFields(existing?.editedFields ?? [], editedKeys);

  const [row] = await db
    .insert(characterPersonas)
    .values({ characterId, persona, editedFields })
    .onConflictDoUpdate({
      target: characterPersonas.characterId,
      set: { persona, editedFields, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export class CharacterPersonaRegenerationError extends Error {
  constructor(
    public readonly kind: 'no_source_image' | 'read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CharacterPersonaRegenerationError';
  }
}

/**
 * Re-runs the generator against the character's current canonical reference
 * image and merges the result into her persona.
 *
 * FAILURE NEVER TOUCHES THE DATABASE. If resolving the source image fails, or
 * the generator itself throws (PersonaGeneratorError), this rethrows
 * immediately without reading or writing the persona row — the existing
 * persona (if any) survives completely untouched. This is the entire
 * mechanism behind the handoff's "persona generation failure must not break
 * ordinary chat" / "never wipe the previous persona on a failed regeneration".
 *
 * On success, generated fields are merged onto the existing persona EXCEPT
 * any key already in `editedFields` — an admin's explicit edit always wins
 * over a fresh generation. `editedFields` itself is unchanged by
 * regeneration; only saveCharacterPersona ever adds to it.
 */
export async function regenerateCharacterPersona(
  db: Db,
  displayName: string,
  characterId: string,
  generator: PersonaGenerator,
): Promise<CharacterPersonaRow> {
  const identity = await getActiveVisualIdentity(db, characterId);
  if (!identity) {
    throw new CharacterPersonaRegenerationError(
      'no_source_image',
      'This character has no active visual identity, so there is no avatar to analyse.',
    );
  }
  const [asset] = await listCanonicalReferences(db, characterId, identity.id);
  if (!asset) {
    throw new CharacterPersonaRegenerationError(
      'no_source_image',
      'This character has no primary reference image, so there is no avatar to analyse.',
    );
  }

  const path = uploadedPathOf(asset);
  if (!path) {
    throw new CharacterPersonaRegenerationError(
      'read_failed',
      'The primary reference image has no readable file on this server.',
    );
  }
  let imageBytes: Buffer;
  try {
    imageBytes = await readFile(path);
  } catch {
    throw new CharacterPersonaRegenerationError(
      'read_failed',
      'The primary reference image could not be read.',
    );
  }

  // Throws PersonaGeneratorError straight through — the whole point of the
  // ordering above (resolve -> read -> THEN generate) is that neither of
  // those steps has written anything, so a generator failure leaves nothing
  // to undo.
  const generated: CharacterPersona = await generator({
    displayName,
    imageBytes,
    imageMimeType: uploadedMimeTypeOf(asset),
  });

  const existing = await getCharacterPersona(db, characterId);
  const editedFields = existing?.editedFields ?? [];
  const merged: CharacterPersona = { ...(existing?.persona ?? {}) };
  for (const [key, value] of Object.entries(generated)) {
    if (editedFields.includes(key)) continue; // admin edit wins, always
    (merged as Record<string, unknown>)[key] = value;
  }

  const [row] = await db
    .insert(characterPersonas)
    .values({
      characterId,
      persona: merged,
      editedFields,
      sourceAssetId: asset.id,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: characterPersonas.characterId,
      set: {
        persona: merged,
        sourceAssetId: asset.id,
        generatedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}
