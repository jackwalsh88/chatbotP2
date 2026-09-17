import { describe, expect, it } from 'vitest';
import {
  parsePersonaField,
  personaFormDiff,
  personaToForm,
} from './characterPersona';
import type { CharacterPersonaFields } from '../lib/api';

/**
 * The avatar-derived persona editor's form logic.
 *
 * THE PROPERTY THAT MATTERS MOST: personaFormDiff must report only fields the
 * admin actually typed into, never the whole form. The backend records every
 * key it receives in `editedFields` and protects those from a later
 * regeneration forever — so a diff that over-reports silently locks fields
 * the admin never meant to touch out of every future "Regenerate from avatar".
 */

describe('personaToForm', () => {
  it('joins array fields with a comma, matching the interests convention', () => {
    const form = personaToForm({ hobbies: ['night runs', 'trashy reality TV'] });
    expect(form.hobbies).toBe('night runs, trashy reality TV');
  });

  it('renders undefined/missing fields as empty strings, not "undefined"', () => {
    const form = personaToForm(undefined);
    expect(form.occupation).toBe('');
    expect(form.age).toBe('');
  });

  it('stringifies a number field', () => {
    expect(personaToForm({ age: 27 }).age).toBe('27');
  });
});

describe('parsePersonaField', () => {
  it('parses a comma list, trimming and dropping empties', () => {
    expect(parsePersonaField('list', 'night runs,  , trashy reality TV ,')).toEqual([
      'night runs',
      'trashy reality TV',
    ]);
  });

  it('an empty list becomes undefined ("nothing typed here"), not []', () => {
    expect(parsePersonaField('list', '   ')).toBeUndefined();
  });

  it('parses a number, rejecting non-numeric text', () => {
    expect(parsePersonaField('number', '27')).toBe(27);
    expect(parsePersonaField('number', '')).toBeUndefined();
    expect(parsePersonaField('number', 'twenty-seven')).toBeUndefined();
  });

  it('trims text, empty becomes undefined', () => {
    expect(parsePersonaField('text', '  barista  ')).toBe('barista');
    expect(parsePersonaField('text', '   ')).toBeUndefined();
  });
});

describe('personaFormDiff', () => {
  const original: Record<string, string> = personaToForm({
    occupation: 'bartender',
    age: 24,
    hobbies: ['mixology'],
  });

  it('is empty when nothing changed', () => {
    expect(personaFormDiff(original, { ...original })).toEqual({});
  });

  it('reports ONLY the field that was actually edited', () => {
    const current = { ...original, occupation: 'barista' };
    const diff = personaFormDiff(original, current);
    expect(diff).toEqual({ occupation: 'barista' });
    expect(diff).not.toHaveProperty('age');
    expect(diff).not.toHaveProperty('hobbies');
  });

  it('reports a new value for a field that was previously empty', () => {
    const diff = personaFormDiff(original, { ...original, education: 'undergraduate' });
    expect(diff).toEqual({ education: 'undergraduate' });
  });

  it('does not report a field cleared back to empty (there is nothing to send)', () => {
    // Clearing a field client-side achieves nothing server-side today (an
    // empty value is simply skipped by validateCharacterPersona), so the
    // diff correctly omits it rather than sending a no-op edit.
    const diff = personaFormDiff(original, { ...original, occupation: '' });
    expect(diff).not.toHaveProperty('occupation');
  });

  it('parses a changed list field back into an array', () => {
    const diff = personaFormDiff(original, { ...original, hobbies: 'mixology, trivia nights' });
    expect(diff).toEqual({ hobbies: ['mixology', 'trivia nights'] });
  });

  it('parses a changed number field back into a number', () => {
    const diff = personaFormDiff(original, { ...original, age: '25' });
    expect(diff).toEqual({ age: 25 });
  });

  it('resaving the SAME persona unchanged reports no edits at all', () => {
    // The regression this whole module exists to prevent: opening the editor,
    // making no changes, and saving must never mark every field as edited.
    const persona: CharacterPersonaFields = {
      occupation: 'nurse',
      age: 27,
      interests: ['reading'],
      demeanor: ['dry'],
    };
    const form = personaToForm(persona);
    expect(personaFormDiff(form, { ...form })).toEqual({});
  });
});
