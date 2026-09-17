import { describe, expect, it } from 'vitest';
import { LlmError } from '../llm/types.js';
import type { LlmVisionClient, LlmVisionRequest } from '../llm/vision-types.js';
import {
  PersonaGeneratorError,
  buildPersonaPrompt,
  createLlmPersonaGenerator,
  extractJsonObject,
  toPersonaGeneratorDraft,
  toProposedProfile,
  unconfiguredPersonaGenerator,
} from '../services/character-persona-generator.js';

/**
 * Persona generation's parsing and failure behaviour, with no database and no
 * network — mirrors character-profile-service.test.ts. A vision-model reply
 * is UNTRUSTED input about to become server-side prompt material, so a
 * malformed or unsafe reply must fail loudly rather than half-apply.
 */

const GOOD = {
  age: 27,
  lifeStage: 'renting with two roommates, still finding her footing',
  occupation: 'second-year ER nurse',
  hobbies: ['night runs', 'trashy reality TV'],
  flirtingStyle: 'teases first, means it second',
};

const INPUT = { displayName: 'Nova', imageBytes: Buffer.from('fake-bytes'), imageMimeType: 'image/jpeg' };

function clientReturning(raw: string, capture?: LlmVisionRequest[]): LlmVisionClient {
  return {
    generate: async (request) => {
      capture?.push(request);
      return raw;
    },
  };
}

describe('extracting the model reply', () => {
  it('reads a bare object, a fenced one, and one buried in prose', () => {
    const json = JSON.stringify(GOOD);
    expect(extractJsonObject(json)).toMatchObject({ age: 27 });
    expect(extractJsonObject('```json\n' + json + '\n```')).toMatchObject({ age: 27 });
    expect(extractJsonObject(`Sure! Here you go:\n${json}\nHope that helps.`)).toMatchObject({
      age: 27,
    });
  });

  it('refuses a reply with no object, and one that is malformed', () => {
    expect(() => extractJsonObject('I would rather not.')).toThrow(PersonaGeneratorError);
    expect(() => extractJsonObject('{ "occupation": ')).toThrow(PersonaGeneratorError);
  });
});

describe('validating a draft', () => {
  it('accepts a valid persona', () => {
    const draft = toPersonaGeneratorDraft(GOOD);
    expect(draft.age).toBe(27);
    expect(draft.hobbies).toEqual(['night runs', 'trashy reality TV']);
  });

  it('drops unknown keys rather than surfacing them', () => {
    const draft = toPersonaGeneratorDraft({ ...GOOD, race: 'should never appear', religion: 'nope' });
    expect(draft).not.toHaveProperty('race');
    expect(draft).not.toHaveProperty('religion');
  });

  it('rejects a persona that denotes a minor', () => {
    expect(() => toPersonaGeneratorDraft({ age: 15 })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ ageRange: 'teenager' })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ lifeStage: 'high school student' })).toThrow(
      PersonaGeneratorError,
    );
  });

  it('rejects an all-empty object as a bad response, not a successful no-op', () => {
    expect(() => toPersonaGeneratorDraft({})).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft({ race: 'x' })).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft('not an object')).toThrow(PersonaGeneratorError);
    expect(() => toPersonaGeneratorDraft(null)).toThrow(PersonaGeneratorError);
  });

  it('tolerates a junk array field without letting it through unbounded', () => {
    const draft = toPersonaGeneratorDraft({
      ...GOOD,
      hobbies: [1, 'reading', null, '  ', ...Array(20).fill('x')],
    });
    expect(draft.hobbies!.length).toBeLessThanOrEqual(6);
    expect(draft.hobbies).toContain('reading');
  });
});

describe('the instruction set', () => {
  it('states the adult/privacy rules, carries the display name, and attaches the image', () => {
    const messages = buildPersonaPrompt(INPUT);
    const systemText = messages[0]!.content as string;
    expect(systemText).toContain('FICTIONAL ADULT');
    expect(systemText).toContain('Never write anything implying a minor');
    expect(systemText).toMatch(/race|religion|sexual orientation/);

    const userContent = messages[1]!.content;
    expect(Array.isArray(userContent)).toBe(true);
    const parts = userContent as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'text')).toBe(true);
    const imagePart = parts.find((p) => p.type === 'image_url') as
      | { type: 'image_url'; image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });
});

function userTextOf(messages: ReturnType<typeof buildPersonaPrompt>): string {
  return (messages[1]!.content as Array<{ type: string; text?: string }>).find(
    (p) => p.type === 'text',
  )!.text!;
}

describe('the photo outranks her existing profile', () => {
  it('supplies the current profile, but names the PHOTO as the authority', () => {
    const userText = userTextOf(
      buildPersonaPrompt({
        ...INPUT,
        shortBio: 'Night-owl astronomy grad student.',
        personality: 'Dreamy, curious, quietly affectionate.',
        interests: ['astronomy', 'lo-fi music'],
      }),
    );
    // She is described to the model, so usable detail can be kept...
    expect(userText).toContain('Night-owl astronomy grad student.');
    expect(userText).toContain('Dreamy, curious, quietly affectionate.');
    expect(userText).toContain('astronomy, lo-fi music');
    // ...but the image decides when the two disagree.
    expect(userText).toContain('THE PHOTO IS THE AUTHORITY');
    expect(userText).toMatch(/keep everything here that fits the photo/i);
  });

  it('says nothing about a current profile when she has none yet', () => {
    const userText = userTextOf(
      buildPersonaPrompt({ ...INPUT, shortBio: '', personality: '  ', interests: [] }),
    );
    expect(userText).not.toContain('THE PHOTO IS THE AUTHORITY');
  });
});

describe('the proposed profile rewrite', () => {
  it('is requested in the third person, with no style or speech directions', () => {
    const systemText = buildPersonaPrompt(INPUT)[0]!.content as string;
    expect(systemText).toContain('proposedShortBio');
    expect(systemText).toContain('proposedPersonality');
    expect(systemText).toContain('THIRD PERSON');
    expect(systemText).toMatch(/no tone, cadence, register or style directions/i);
  });

  it('parses a descriptive proposal', () => {
    const profile = toProposedProfile({
      proposedShortBio: 'She is 24 and halfway through an astronomy doctorate.',
      proposedPersonality: 'Unhurried and watchful, warmer once she trusts someone.',
      proposedInterests: ['deep-sky photography', 'secondhand bookshops'],
    });
    expect(profile?.shortBio).toContain('astronomy doctorate');
    expect(profile?.interests).toEqual(['deep-sky photography', 'secondhand bookshops']);
  });

  it('REJECTS text that instructs rather than describes — the Phase 1 defect', () => {
    // Exactly the shape that broke production before: a bio carrying speech
    // directions, which then outranks the code-owned behaviour layer.
    expect(
      toProposedProfile({
        proposedShortBio: 'You treat every conversation like a field recording.',
      }),
    ).toBeUndefined();
    expect(
      toProposedProfile({
        proposedPersonality: 'Respond with poetic restraint and vivid sensory description.',
      }),
    ).toBeUndefined();
    expect(
      toProposedProfile({ proposedShortBio: 'Her cadence is low and deliberate.' }),
    ).toBeUndefined();
  });

  it('keeps a clean field when a sibling field is instructional', () => {
    const profile = toProposedProfile({
      proposedShortBio: 'She is a second-year ER nurse who runs at night.',
      proposedPersonality: 'Speak in a low, deliberate cadence.',
    });
    expect(profile?.shortBio).toContain('ER nurse');
    expect(profile?.personality).toBeUndefined();
  });

  it('is absent, not an error, when the model offers none', () => {
    expect(toProposedProfile({ age: 24 })).toBeUndefined();
    expect(toProposedProfile(null)).toBeUndefined();
    expect(toProposedProfile('nope')).toBeUndefined();
  });

  it('an absent proposal never costs the operator the persona', async () => {
    // The persona is the deliverable; the rewrite is an offer.
    const generator = createLlmPersonaGenerator(clientReturning(JSON.stringify(GOOD)));
    const result = await generator(INPUT);
    expect(result.persona.occupation).toBe('second-year ER nurse');
    expect(result.profile).toBeUndefined();
  });

  it('carries the proposal through when the model does offer one', async () => {
    const generator = createLlmPersonaGenerator(
      clientReturning(
        JSON.stringify({ ...GOOD, proposedShortBio: 'She is 27 and works nights in an ER.' }),
      ),
    );
    const result = await generator(INPUT);
    expect(result.profile?.shortBio).toContain('works nights in an ER');
  });
});

describe('the generator', () => {
  it('turns a model reply into a persona, and passes the image through', async () => {
    const seen: LlmVisionRequest[] = [];
    const generator = createLlmPersonaGenerator(clientReturning(JSON.stringify(GOOD), seen));
    const result = await generator(INPUT);
    expect(result.persona.occupation).toBe('second-year ER nurse');
    expect(seen[0]!.messages[0]!.role).toBe('system');
  });

  it('never leaks provider detail when inference fails', async () => {
    const secretish = 'HTTP 401 from https://provider.invalid key=sk-do-not-leak';
    const generator = createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('http', secretish, 401);
      },
    });
    const error = await generator(INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(PersonaGeneratorError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toContain('sk-do-not-leak');
    expect(error.message).not.toContain('provider.invalid');
  });

  it('distinguishes "not configured" and "timed out" for the operator', async () => {
    const notConfigured = await createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('not_configured', 'no endpoint');
      },
    })(INPUT).catch((e) => e);
    expect(notConfigured.kind).toBe('not_configured');

    const timedOut = await createLlmPersonaGenerator({
      generate: async () => {
        throw new LlmError('timeout', 'took too long');
      },
    })(INPUT).catch((e) => e);
    expect(timedOut.kind).toBe('unavailable');
    expect(timedOut.message).toContain('too long');
  });

  it('the unconfigured generator refuses rather than faking a persona', async () => {
    const error = await Promise.resolve()
      .then(() => unconfiguredPersonaGenerator(INPUT))
      .catch((e) => e);
    expect(error).toBeInstanceOf(PersonaGeneratorError);
    expect(error.kind).toBe('not_configured');
  });
});
