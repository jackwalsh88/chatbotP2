import { describe, expect, it } from 'vitest';
import { LlmError } from '../llm/types.js';
import type { LlmVisionClient, LlmVisionRequest } from '../llm/vision-types.js';
import {
  PersonaGeneratorError,
  buildPersonaPrompt,
  createLlmPersonaGenerator,
  extractJsonObject,
  toPersonaGeneratorDraft,
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

describe('her established profile constrains the generated persona', () => {
  it('states an existing bio/personality/interests as already true, and forbids contradicting them', () => {
    const messages = buildPersonaPrompt({
      ...INPUT,
      shortBio: 'Night-owl astronomy grad student.',
      personality: 'Dreamy, curious, quietly affectionate.',
      interests: ['astronomy', 'lo-fi music'],
    });
    const userText = (messages[1]!.content as Array<{ type: string; text?: string }>).find(
      (p) => p.type === 'text',
    )!.text!;
    expect(userText).toContain('ALREADY ESTABLISHED');
    expect(userText).toContain('Night-owl astronomy grad student.');
    expect(userText).toContain('Dreamy, curious, quietly affectionate.');
    expect(userText).toContain('astronomy, lo-fi music');
    // The instruction that stops a bio-contradicting occupation being invented.
    expect(userText).toMatch(/keep that occupation|never contradict/i);
  });

  it('says nothing about an established profile when she has none yet', () => {
    // A quick-created draft: the persona is free to invent, because there is
    // nothing to contradict.
    const messages = buildPersonaPrompt({ ...INPUT, shortBio: '', personality: '  ', interests: [] });
    const userText = (messages[1]!.content as Array<{ type: string; text?: string }>).find(
      (p) => p.type === 'text',
    )!.text!;
    expect(userText).not.toContain('ALREADY ESTABLISHED');
  });
});

describe('the generator', () => {
  it('turns a model reply into a persona, and passes the image through', async () => {
    const seen: LlmVisionRequest[] = [];
    const generator = createLlmPersonaGenerator(clientReturning(JSON.stringify(GOOD), seen));
    const persona = await generator(INPUT);
    expect(persona.occupation).toBe('second-year ER nurse');
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
