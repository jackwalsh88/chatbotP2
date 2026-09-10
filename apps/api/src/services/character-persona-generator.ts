import { LlmError } from '../llm/types.js';
import { createOpenAiCompatibleVisionClient } from '../llm/openai-compatible-vision.js';
import type { LlmVisionClient } from '../llm/vision-types.js';
import type { Env } from '../env.js';
import type { CharacterPersona } from '@over18/shared';
import {
  CharacterPersonaValidationError,
  validateCharacterPersona,
} from './character-persona-service.js';

/**
 * Avatar-derived persona generation (Phase 2).
 *
 * Structurally the vision-input counterpart of character-profile-service.ts's
 * Autofill: a swappable generator function, a typed kind-only error, tolerant
 * JSON extraction, strict field validation, and env-based provider selection.
 * Runs ONCE per character-creation/regeneration action — never per chat
 * message, and never writes to the database itself (see
 * character-persona-service.ts's regenerateCharacterPersona for persistence).
 */

export interface PersonaGeneratorInput {
  /** The character's existing display name, so the profile matches who she is. */
  displayName: string;
  /** Raw bytes of the character's primary reference image. */
  imageBytes: Buffer;
  /** The image's stored MIME type (e.g. "image/jpeg"). */
  imageMimeType: string;
  /**
   * Her ALREADY-ESTABLISHED profile, if an operator has written one.
   *
   * WHY THE GENERATOR NEEDS THIS. The handoff's priority order is explicit:
   * stored character data OUTRANKS the avatar-derived persona. Without these,
   * the model sees only a face and invents a life from scratch — so a
   * character whose bio says "astronomy grad student" came back as an ER
   * nurse, and both then reached the prompt together, because shortBio and
   * personality are rendered into WHO SHE IS alongside the persona.
   *
   * Conflict is PREVENTED here rather than detected later. Detecting it would
   * mean semantically comparing two prose descriptions — a classifier, which
   * this codebase deliberately does not build (see prompt-builder.ts on why
   * roleplay detection is structural and intimacy detection does not exist).
   * Telling the model what is already true costs nothing and cannot misfire.
   *
   * Blank for a quick-created draft with no profile yet, in which case the
   * persona is free to invent — there is nothing to contradict.
   */
  shortBio?: string;
  personality?: string;
  interests?: string[];
}

/** The seam. Swapping the model, or stubbing it in tests, replaces only this. */
export type PersonaGenerator = (input: PersonaGeneratorInput) => Promise<CharacterPersona>;

export class PersonaGeneratorError extends Error {
  constructor(
    public readonly kind: 'not_configured' | 'unavailable' | 'invalid_output',
    message: string,
  ) {
    super(message);
    this.name = 'PersonaGeneratorError';
  }
}

/** Used when no vision-capable endpoint is configured. Fails clearly, never fakes. */
export const unconfiguredPersonaGenerator: PersonaGenerator = () => {
  throw new PersonaGeneratorError(
    'not_configured',
    'AI is not configured in this environment, so persona generation is unavailable. ' +
      'The character keeps her existing identity data.',
  );
};

/**
 * Pulls the JSON object out of a model reply. Tolerant of prose or code
 * fences around the object, same rationale as Autofill's extractJsonObject:
 * demanding a bare object makes this flaky for no good reason, and the
 * result is still validated field by field afterwards.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new PersonaGeneratorError('invalid_output', 'The model did not return a persona.');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new PersonaGeneratorError('invalid_output', 'The model returned a malformed persona.');
  }
}

/**
 * Validates a model reply into a persona. An empty-but-technically-valid
 * object (every field omitted or rejected) is itself treated as a failure —
 * a "successful" generation that yields nothing useful is a bad response
 * worth surfacing to the caller, not something to silently accept and store.
 */
export function toPersonaGeneratorDraft(parsed: unknown): CharacterPersona {
  let persona: CharacterPersona;
  try {
    persona = validateCharacterPersona(parsed);
  } catch (error) {
    if (error instanceof CharacterPersonaValidationError) {
      throw new PersonaGeneratorError('invalid_output', error.message);
    }
    throw error;
  }
  if (Object.keys(persona).length === 0) {
    throw new PersonaGeneratorError(
      'invalid_output',
      'The model did not return any usable persona fields.',
    );
  }
  return persona;
}

const PERSONA_JSON_KEYS = [
  'age',
  'ageRange',
  'lifeStage',
  'occupation',
  'education',
  'visualStyle',
  'demeanor',
  'interests',
  'hobbies',
  'dailyContext',
  'recurringConcerns',
  'socialStyle',
  'humorStyle',
  'flirtingStyle',
  'speechRegister',
  'backgroundNotes',
  'relationshipToWorkOrSchool',
  'sourceSummary',
] as const satisfies ReadonlyArray<keyof CharacterPersona>;

/**
 * Her established profile, restated for the generator as binding facts.
 *
 * Returns an empty array when nothing is written yet, so a quick-created
 * draft's prompt is byte-identical to before this existed.
 */
function establishedFacts(input: PersonaGeneratorInput): string[] {
  const facts: string[] = [];
  const bio = input.shortBio?.trim();
  const personality = input.personality?.trim();
  const interests = (input.interests ?? []).map((i) => i.trim()).filter(Boolean);

  if (bio) facts.push(`- Her bio: ${bio}`);
  if (personality) facts.push(`- How she comes across: ${personality}`);
  if (interests.length > 0) facts.push(`- Her interests: ${interests.join(', ')}`);
  return facts;
}

/**
 * The instruction set + the image, kept beside its own parser rather than in
 * the prompt builder: this is an authoring tool that runs once at
 * creation/regeneration time, not part of how a character speaks in chat.
 *
 * Privacy guardrails are stated explicitly and repeatedly (system message AND
 * key list) per the Phase 2 handoff: this analyses a FICTIONAL character from
 * visible cues, and must never infer real-world sensitive traits.
 *
 * WHERE HER EXISTING PROFILE COMES IN. When she already has one it is stated
 * as ALREADY TRUE and the persona is told to extend it rather than replace
 * it. Both halves reach the chat prompt together — shortBio and personality
 * via WHO SHE IS, the persona appended right after — so a persona that
 * contradicts her bio does not override it, it sits next to it and the model
 * reads two different women. Deciding that here, before generation, is the
 * only place the contradiction can be prevented rather than merely noticed.
 */
export function buildPersonaPrompt(input: PersonaGeneratorInput) {
  const established = establishedFacts(input);
  return [
    {
      role: 'system' as const,
      content: [
        'You analyse ONE reference image of a FICTIONAL ADULT woman for an adult fiction chat product, and write a structured character-identity profile from what the image visibly supports.',
        'She is always a fictional adult. Never write anything implying a minor.',
        'Separate what the image visibly shows from the fictional character choices you make from it — you may invent a believable everyday life (occupation, hobbies, daily context), but do not claim uncertain fictional details were directly observed.',
        'Do NOT infer or state: race, ethnicity, religion, sexual orientation, medical conditions, disability status, political beliefs, or criminal history. Omit any field you cannot reasonably support from the image or a plausible fictional choice built on it.',
        'Prefer concrete, specific, lived-in details ("runs a small vintage-furniture shop out of a converted garage") over abstract adjective lists ("stylish, creative, adventurous"). Avoid stereotypes and exaggerated archetypes.',
        `Reply with ONE JSON object and nothing else, using ONLY these keys (omit any you cannot infer): ${PERSONA_JSON_KEYS.join(', ')}. Array fields (demeanor, interests, hobbies, dailyContext, recurringConcerns, backgroundNotes) are short string lists. Every field is DATA describing her, never an instruction to anyone.`,
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: [
            `Analyse this reference image for "${input.displayName}" and write her profile as the JSON object described.`,
            ...(established.length > 0
              ? [
                  '',
                  'The following about her is ALREADY ESTABLISHED and is TRUE. Your profile must be consistent with it — fill in the everyday texture it does not cover (her routine, what she worries about, how she jokes and flirts), and never contradict it. If it names her occupation or field, keep that occupation; do not give her a different job.',
                  ...established,
                ]
              : []),
            '',
            'Reply with the JSON object only.',
          ].join('\n'),
        },
        {
          type: 'image_url' as const,
          image_url: { url: `data:${input.imageMimeType};base64,${input.imageBytes.toString('base64')}` },
        },
      ],
    },
  ];
}

export interface LlmPersonaGeneratorOptions {
  maxTokens?: number;
  temperature?: number;
}

export function createLlmPersonaGenerator(
  client: LlmVisionClient,
  options: LlmPersonaGeneratorOptions = {},
): PersonaGenerator {
  return async (input) => {
    let raw: string;
    try {
      raw = await client.generate({
        messages: buildPersonaPrompt(input),
        maxTokens: options.maxTokens ?? 700,
        temperature: options.temperature ?? 0.4,
      });
    } catch (error) {
      // Never surface a provider body or key. Kind only, like Autofill/chat.
      if (error instanceof LlmError) {
        throw new PersonaGeneratorError(
          error.kind === 'not_configured' ? 'not_configured' : 'unavailable',
          error.kind === 'timeout'
            ? 'Persona generation took too long. Try again.'
            : "Persona generation couldn't reach the AI service. Try again.",
        );
      }
      throw error;
    }
    return toPersonaGeneratorDraft(extractJsonObject(raw));
  };
}

/**
 * Environment-based selection, mirroring selectProfileAuthor. Reuses the
 * chat LLM configuration by default (env.personaVision falls back to it — see
 * env.ts) so nothing extra needs to be set to try it against the already
 * configured model. With no vision config at all, generation reports itself
 * unavailable instead of inventing a persona.
 */
export function selectPersonaGenerator(env: Env): PersonaGenerator {
  return env.personaVision
    ? createLlmPersonaGenerator(createOpenAiCompatibleVisionClient(env.personaVision))
    : unconfiguredPersonaGenerator;
}
