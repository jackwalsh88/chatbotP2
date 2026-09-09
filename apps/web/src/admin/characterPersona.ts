import type { CharacterPersonaFields } from '../lib/api';

/**
 * Avatar-derived persona form logic (Phase 2) — presentation-and-diffing
 * logic, React-free, same reasoning as characterContent.ts: this repo's web
 * tests run in node with no DOM, so anything worth getting right lives here
 * where a static render cannot catch it, and gets tested directly.
 */

/**
 * Field config for the persona editor.
 *
 * `sourceSummary` is deliberately absent: it is generator-only, admin-review
 * text ("what the image visibly supports") and is never rendered into the
 * chat prompt — the page shows it read-only, never as an editable field.
 */
export type PersonaFieldKind = 'text' | 'number' | 'list';

export const PERSONA_FIELDS: ReadonlyArray<{
  key: keyof CharacterPersonaFields;
  label: string;
  kind: PersonaFieldKind;
}> = [
  { key: 'age', label: 'Age', kind: 'number' },
  { key: 'ageRange', label: 'Age range', kind: 'text' },
  { key: 'lifeStage', label: 'Life stage', kind: 'text' },
  { key: 'occupation', label: 'Occupation', kind: 'text' },
  { key: 'education', label: 'Education', kind: 'text' },
  { key: 'relationshipToWorkOrSchool', label: 'Relationship to work/school', kind: 'text' },
  { key: 'visualStyle', label: 'Visual style', kind: 'text' },
  { key: 'demeanor', label: 'Demeanor', kind: 'list' },
  { key: 'interests', label: 'Interests (persona)', kind: 'list' },
  { key: 'hobbies', label: 'Hobbies', kind: 'list' },
  { key: 'dailyContext', label: 'Daily context', kind: 'list' },
  { key: 'recurringConcerns', label: 'Recurring concerns', kind: 'list' },
  { key: 'socialStyle', label: 'Social style', kind: 'text' },
  { key: 'humorStyle', label: 'Humor style', kind: 'text' },
  { key: 'flirtingStyle', label: 'Flirting style', kind: 'text' },
  { key: 'speechRegister', label: 'Speech register', kind: 'text' },
  { key: 'backgroundNotes', label: 'Background notes', kind: 'list' },
];

/** Every field as its editable text representation — arrays comma-joined, same convention `interestsText` already uses. */
export function personaToForm(persona: CharacterPersonaFields | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of PERSONA_FIELDS) {
    const value = persona?.[field.key];
    if (field.kind === 'list') out[field.key] = Array.isArray(value) ? value.join(', ') : '';
    else out[field.key] = value === undefined || value === null ? '' : String(value);
  }
  return out;
}

/** Parses one field's text back into its proper shape. Empty text -> undefined ("nothing typed here"). */
export function parsePersonaField(kind: PersonaFieldKind, raw: string): unknown {
  const trimmed = raw.trim();
  if (kind === 'list') {
    const items = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (kind === 'number') {
    if (trimmed.length === 0) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Only the fields whose text actually changed from what was loaded — NOT the
 * whole form. This matters: saving the whole form every time would mark
 * every field as admin-edited (editedFields), permanently locking fields the
 * admin never touched out of future regeneration. Diffing against the
 * ORIGINAL text (not the original typed object) keeps comparison simple and
 * exact — same string in, same string out, is "unchanged" regardless of type.
 */
export function personaFormDiff(
  original: Record<string, string>,
  current: Record<string, string>,
): Partial<CharacterPersonaFields> {
  const edits: Record<string, unknown> = {};
  for (const field of PERSONA_FIELDS) {
    if ((current[field.key] ?? '') === (original[field.key] ?? '')) continue;
    const parsed = parsePersonaField(field.kind, current[field.key] ?? '');
    if (parsed !== undefined) edits[field.key] = parsed;
  }
  return edits as Partial<CharacterPersonaFields>;
}
