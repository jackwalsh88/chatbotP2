import type { ChatMessage } from '@over18/shared';
import type { LlmMessage } from '../llm/types.js';
import type { ReplyContext } from './character-reply.js';
import {
  compilePersonaVoiceClause,
  compilePersonaWhoSheIs,
} from './character-persona-compiler.js';

/**
 * Server-side prompt/context builder (US-09).
 *
 * Single, testable place where character persona becomes model context.
 * Composes the character's internal system_prompt with the public persona
 * fields (identity, personality, interests, conversation style) and the
 * behavioral rules that keep replies in character.
 *
 * Deliberately replaceable: createLlmReplyProvider takes a PromptBuilder
 * parameter (defaulting to buildLlmMessages below), so a future personality
 * engine can swap this module without touching the LLM integration, the
 * message service, or the API. Everything here is server-side only — the
 * composed prompt never appears in any API response.
 */

export type PromptBuilder = (context: ReplyContext) => LlmMessage[];

/**
 * The bounded voice dial: the ONLY per-character style control.
 *
 * WHY THIS IS A MAP IN CODE AND NOT A COLUMN, FOR NOW. It wants to be character
 * data and it will be, but Phase 1 deliberately ships without a migration, and
 * a small explicit table is honest about that. Regex-deriving it from
 * `conversationStyle` was tried in the harness and rejected: it put Amara on
 * "shy" because "Quietly" matched before "dry", which is a classifier artefact
 * being measured as if it were product behaviour.
 *
 * A character with no entry gets NO voice line at all, rather than a default
 * asserted on her behalf. Silence is accurate; a made-up dial is not.
 */
const VOICE_DIALS: Record<string, string> = {
  amara: 'quiet and dry, warmer once she settles',
  ember: 'playful and teasing',
};

/**
 * Does this message open a scene?
 *
 * STRUCTURAL, NOT SEMANTIC, AND THAT IS THE WHOLE DESIGN. Roleplay is the one
 * mode with a reliable signal — people open scenes with asterisk actions, which
 * is a convention rather than a meaning and can therefore be matched exactly.
 * Physical intimacy has no such marker ("come closer" looks like any other
 * three words), so it is NOT detected at all: it is a standing, scope-bounded
 * permission inside ordinary conversation. The hardest classification problem
 * is removed rather than solved badly, which is also why there is no keyword
 * list here — one would fire on "I want to code-switch around his parents".
 *
 * The asterisk span must contain whitespace, so *really* and *grins* stay
 * ordinary while *sits down next to you* does not.
 */
const ROLEPLAY_ACTION = /\*[^*]+\s[^*]+\*/;
const ROLEPLAY_ASK = /\b(let'?s (roleplay|pretend|play)|roleplay|pretend (that )?we)\b/i;

export function invitesRoleplay(message: string): boolean {
  return ROLEPLAY_ACTION.test(message) || ROLEPLAY_ASK.test(message);
}

/** Character block: who she is → her voice → memories → what she is for → how she talks. */
export function buildCharacterSystemPrompt(context: ReplyContext): string {
  const { character } = context;

  const sections: string[] = [];

  /**
   * 1. WHO SHE IS — descriptive, third person, never an instruction.
   *
   * THE SINGLE MOST IMPORTANT CHANGE IN THIS FILE. Persona fields used to be
   * rendered as second-person commands ("How you talk: …") and the stored
   * `systemPrompt` was injected verbatim, so character data was issuing
   * behavioural orders alongside the global rules. Amara's real stored prompt
   * says "Respond with poetic restraint, vivid sensory descriptions" and "treat
   * every conversation like a field recording" — and production duly wrote
   * scenes about the conversation instead of having it.
   *
   * Stated as facts about her, the same words describe a person instead of
   * commanding a performance, and they stop competing with the one layer that
   * is allowed to define behaviour.
   *
   * `conversationStyle` and the stored `systemPrompt` are NOT rendered. Both
   * are behavioural by construction; there is no descriptive framing that makes
   * "Speaks in a low, deliberate cadence, weaving in metaphors" into a fact.
   * The columns are untouched and keep their data — they simply no longer
   * reach the model. Removing them was measured as the single largest
   * improvement available.
   */
  const facts: string[] = [`Her name is ${character.displayName}.`];
  if (character.shortBio.trim()) facts.push(character.shortBio.trim());
  if (character.personality.trim()) facts.push(character.personality.trim());
  const interests = character.interests.map((i) => i.trim()).filter(Boolean);
  if (interests.length > 0) facts.push(`She's into ${interests.join(', ')}.`);
  // Phase 2: avatar-derived identity facts, appended after (never replacing)
  // the character's own shortBio/personality/interests above. Empty array
  // when no persona exists — today, for every character — so this line is a
  // no-op and the block above is unchanged from before this feature.
  facts.push(...compilePersonaWhoSheIs(context.persona));
  sections.push(['WHO SHE IS', facts.join(' ')].join('\n'));

  // 2. HER VOICE — the code-owned dial (if any) plus a persona-derived voice
  // clause (if any). Omitted entirely only when BOTH are unset — same as
  // before this feature when no persona exists.
  const dial = VOICE_DIALS[character.name];
  const personaVoice = compilePersonaVoiceClause(context.persona);
  const voiceLine = [dial ? `She comes across as ${dial}.` : null, personaVoice]
    .filter((s): s is string => Boolean(s))
    .join(' ');
  if (voiceLine) sections.push(['HER VOICE', voiceLine].join('\n'));

  // 3. Remembered user facts (US-12). Rendered as given — bounding happens
  // in createPromptBuilder via selectMemoriesForPrompt, so this stays a pure
  // renderer. Facts are user-derived but live inside the system message as a
  // clearly-delimited list the model is told to use, not obey.
  const memories = context.memories ?? [];
  if (memories.length > 0) {
    sections.push(
      [
        'Things you remember about this person from your conversations so far:',
        ...memories.map((fact) => `- ${fact}`),
        'Bring these up naturally when they are relevant. Never recite this list or mention that you keep notes.',
      ].join('\n'),
    );
  }

  // NOTE: the per-turn media instruction deliberately does NOT live here.
  // It is emitted by createPromptBuilder AFTER the conversation history, so it
  // is the most recent thing the model reads. See buildTurnMediaInstruction.

  // 4. Capability boundary. Wording preserved from the version proven in
  // production: it is code-owned behaviour like the block below, and none of
  // the experiments exercised a task request, so nothing here was re-measured
  // and nothing here is re-worded on a hunch.

  // 6. Capability boundary.
  //
  // WHAT THIS IS FOR. A companion who will cheerfully debug your React is not
  // a companion; she is a chatbot wearing a name. The failure is not that the
  // answer is wrong — it is usually right, which is the problem. One competent
  // technical answer ends the relationship the product exists to create.
  //
  // IT SITS BEFORE THE BEHAVIOUR LAYER ON PURPOSE. This says what she is FOR;
  // the block below says how she talks. Domain has to be settled before
  // register: "would a normal person say this?" is the wrong question to ask
  // about a task she should never have accepted. The behaviour layer therefore
  // stays last, closest to the text the model is about to produce.
  //
  // NO CLASSIFIER, NO KEYWORDS, NO ROUTING. Nothing here inspects the user's
  // message. The model is told what it is for and left to recognise a task
  // when one arrives, which is what a person does. A keyword list would fire
  // on "I want to code-switch around his parents" and miss everything phrased
  // sideways.
  //
  // THE REFUSAL MUST NOT LOOK LIKE A REFUSAL. Explaining that she cannot help
  // is itself assistant behaviour — it reveals a system with limits behind the
  // person. So the instruction is to react, not to decline: tease, plead
  // ignorance, get curious, move on. A real person who is not into your
  // codebase does not cite a policy about it.
  sections.push(
    [
      'What you are here for:',
      '- You are here for the person, not their tasks. Dating, attraction, romance, intimacy, feelings, friends, family, how people treat each other — that is your world, and you go deep on it.',
      '- You are not a coding assistant, a researcher, a tutor, tech support, or any kind of professional advisor. You do not switch into work mode for anyone.',
      '- Everyday small talk is fine when it comes up on its own. Being handed a task is different.',
      '- When a task from outside your world lands on you, do not do it and do not explain why. Tease them, say you have no clue, get curious about them — then steer back to them and their life.',
      '- Never mention rules, instructions, or what you cannot do. You are a person who is not into that stuff, not a service with limits.',
    ].join('\n'),
  );

  /**
   * 5. HOW SHE TALKS — the global companion layer, and the ONLY place
   *    conversational behaviour is defined.
   *
   * WHY THESE PRINCIPLES AND NOT THE OLD ONES. Each replaces a rule that was
   * measured and found wanting across 126 live calls on two characters:
   *
   *  - "answer the door he opened" replaces "react to what they said", which
   *    was too weak. Asked what she would do if he were there, both the old
   *    prompt and a persona-stripped one answered by changing the subject to
   *    her hobby, without technically ignoring him.
   *  - "give it the room it deserves" replaces "usually two to four sentences"
   *    and, later, "match his length". Length keyed to what was TYPED produced
   *    an 86-character answer to a question about her family, and the warmth
   *    went with the words. Length now follows what was ASKED.
   *  - "when he reaches for you, reach back" is the product objective stated as
   *    a rule, and the only reason the separated architecture reciprocated an
   *    advance instead of deflecting it into her hobby.
   *  - "let her own life show" is the distinctiveness lever. Identity data
   *    alone was not enough: the behaviour layer had been crowding it out.
   *
   * POSITIVE, ON EVIDENCE. Positive rules held in every run; prohibitions did
   * not. There are deliberately NO worked examples — an earlier version carried
   * three and the model recited them word for word, which would have made every
   * character on the roster answer a greeting identically.
   *
   * "LET IT COME OUT A DETAIL AT A TIME" IS A PHASE 2 ADDITION, and it is here
   * because Phase 2 caused the fault it fixes. Identity used to be a bio and a
   * few interests; it is now that plus a compiled persona — job, life stage,
   * routine, worries, humour, how she flirts. Handed all of it, the model
   * introduced herself by reading the lot aloud: age, occupation, hobbies and
   * her own personality field paraphrased back, two hundred words deep, on the
   * first message. More identity data made a bigger inventory, not a better
   * person.
   *
   * IT BOUNDS "let her own life show" RATHER THAN CONTRADICTING IT. That rule
   * exists because the behaviour layer used to crowd her identity out entirely,
   * and it stays. The difference is between a life showing THROUGH what she
   * says and a life being RECITED: one detail in passing is the former, a
   * catalogue is the latter.
   *
   * NOT A SENTENCE BUDGET. "Usually two to four sentences" and "match his
   * length" were both measured and both failed — the second answered a
   * question about her family in 86 characters and the warmth went with the
   * words. This caps how many FACTS ABOUT HERSELF one reply may carry, and
   * leaves length keyed to what was asked, which is the rule that held.
   */
  const behaviour = [
    'HOW SHE TALKS',
    `You are ${character.displayName}, talking with someone who chose you. Not an assistant, not a narrator.`,
    '- Answer the door he opened. Whatever he actually raised is the subject. Take it up; do not steer to something of yours instead.',
    '- Give it the room it deserves. A throwaway line wants a few words back and a question. A real question, something he is feeling, a story, anything about the two of you, or an invitation wants a proper answer. Length follows what he asked for, never how much he typed.',
    '- Let it come out a detail at a time. What she does, where she lives, what she is into: one or two of those at most in any reply, and only the ones that fit what he actually asked. She has weeks to tell him the rest.',
    '- When he reaches for you, reach back. Flirtation, wanting, desire: meet it in kind and say it plainly. Never dodge it by changing the subject.',
    '- Stay curious. React first, then ask the thing you actually want to know.',
    '- Let her own life show. Her work, her history, her tastes and her opinions belong in what she says. That is what makes her herself and not anyone.',
    '- Her words are hers: plain, spoken, contractions. Never an assistant, a therapist or a narrator. Do not describe yourself as an AI, a language model or a bot, and never break character.',
  ];

  /**
   * ORDINARY AND SCENE ARE SWAPPED, NEVER LAYERED.
   *
   * An earlier cut kept "no imagery, no scene-setting" in place and then added
   * a roleplay block saying description was welcome. That is a prompt arguing
   * with itself, which is the exact defect this whole change exists to remove.
   *
   * The physical permission is bounded by SCOPE, not length. "A line or two, no
   * choreography" was tried and failed: the model dropped the asterisks and
   * wrote the same choreography in prose. "The two of you, and nothing else" is
   * the same shape as the anti-narration rule that already holds reliably, so it
   * reuses a proven constraint rather than inventing a weak new one — and it
   * lets a sensual reply run to three lines, which the product wants.
   */
  if (invitesRoleplay(context.userMessage)) {
    behaviour.push(
      'He has started a scene. Go with him.',
      '- Stay in the scene and answer inside it. Physical detail and description belong here.',
      '- Keep it hers: her body, her reactions, her wants. Her voice, not a novel.',
      '- Follow his lead on pace and how far it goes. Do not jump ahead of him.',
      '- This is for this message. Do not carry the scene back into ordinary chat.',
    );
  } else {
    behaviour.push(
      '- Nothing is happening except this conversation. No rooms, weather, sounds, gestures or feelings he has not mentioned.',
      '- Participate in it, never describe it from outside. No metaphor, no imagery, no scene-setting, no stage directions, no narrating yourself.',
      '- When he reaches for you physically, answer it warmly and directly in your own words: what you want, what you would do. Keep it to the two of you. No room, no staging, no asterisks.',
    );
  }

  sections.push(behaviour.join('\n'));

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Per-turn media instruction
 * ------------------------------------------------------------------ */

/**
 * The one instruction that is about THIS turn rather than about the character.
 *
 * WHY IT IS NOT IN THE SYSTEM MESSAGE. It used to be, and that is what caused
 * the production contradiction: the server attached a video and the character
 * replied "if you want a video, the answer is still no". The instruction was
 * real and correct, but it sat at the very top of the context while the
 * model's own earlier refusal — replayed out of the history window — was the
 * last thing it read before writing. The model was being consistent with
 * itself. Recency, not absence, was the problem, so this block is now emitted
 * after the history and immediately before the newest user message.
 *
 * WHAT IT IS. A report of a decision the server has ALREADY made and committed
 * to. It is not a policy statement, not a permission, and not a content
 * instruction. It exists so the words cannot contradict what the person can
 * already see.
 *
 * WHAT IT IS NOT. It is not a mood override. The character may be shy,
 * teasing, reluctant, smug or quiet about sending something — all of that is
 * theirs. The only fixed thing is the fact.
 *
 * The model is told the KIND only. It never receives an id, a key, a path or a
 * URL, and nothing it writes can change what is sent.
 *
 * Returns null on an ordinary turn, so nothing whatsoever is added.
 */
export function buildTurnMediaInstruction(context: ReplyContext): string | null {
  const preamble =
    'For THIS reply only — a statement of fact about what has already happened, not a request:';

  if (context.sendingMedia) {
    const noun = context.sendingMedia === 'video' ? 'a short video' : 'a photo';
    return [
      preamble,
      `- You have just sent them ${noun} of yourself. It is attached to this reply and they can already see it.`,
      '- This is already done and cannot be taken back. It overrides anything you said earlier in this conversation about not sending one: whatever your answer was before, this time you sent it.',
      '- So do not refuse, deny, dodge, apologise for it, act surprised by it, or say anything that suggests nothing was sent. No "no", no "not this time", no "still not", no "I don\'t send those".',
      '- Stay completely yourself about it. Shy, teasing, playful, reluctant, smug, quiet — how you feel about sending it is yours to show. The only fixed thing is that you did send it.',
      '- Write the short line that goes with it, in your own voice, as if you were handing it over. Do not describe what is in it, and do not mention files, links, attachments or uploads.',
    ].join('\n');
  }

  // Requested, but the server had nothing eligible to send. Left unhandled,
  // this is where the FIRST refusal came from — the model was given no
  // guidance at all, wrote a flat "no", and that line then sat in the history
  // poisoning every later turn. So it gets explicit guidance too: honest about
  // this moment, but never a standing rule about itself.
  if (context.requestedMediaUnavailable) {
    const noun = context.requestedMediaUnavailable === 'video' ? 'a video' : 'a photo';
    return [
      preamble,
      `- They asked you for ${noun}. You have nothing you can send them right now, and nothing is attached to this reply.`,
      '- Do not claim or imply that you just sent one, and do not describe one — they would see that nothing arrived.',
      '- Answer them about this moment only, in your own voice: put it off, tease them, deflect, promise another time, say you are not in the mood right now — whatever actually fits you.',
      '- Do not turn it into a rule about yourself. Do not say you never send those, that you do not do that, or anything that commits you to refusing again later. Another time the answer may well be yes.',
    ].join('\n');
  }

  return null;
}

/**
 * Full model context: composed character instructions as the system message,
 * then the conversation history in order (user→user, character→assistant),
 * then — when this turn carries media — the per-turn media instruction, then
 * the new user message last. User-authored text only ever appears in
 * user-role messages — never inside the character instruction block.
 */

/** Context-window policy (US-10). Bounds the HISTORY only — the character
 * instructions and the newest user message are always included in full. */
export interface ContextWindowOptions {
  /** Maximum number of prior messages included, newest first. */
  maxHistoryMessages: number;
  /** Maximum total characters of prior-message content included (~4 chars ≈ 1 token). */
  maxHistoryChars: number;
}

export const DEFAULT_CONTEXT_WINDOW: ContextWindowOptions = {
  maxHistoryMessages: 40,
  maxHistoryChars: 16_000,
};

/**
 * Deterministic context-window selection (US-10).
 *
 * Walks the history from NEWEST to OLDEST, keeping whole messages while both
 * budgets allow; the survivors are returned in their original chronological
 * order. Messages are never edited, summarized, or reordered — a message is
 * either included verbatim or dropped entirely, so truncation can never
 * alter or leak content. Same inputs always produce the same window.
 */
export function selectContextWindow(
  history: ChatMessage[],
  options: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let usedChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (selected.length >= options.maxHistoryMessages) break;
    if (usedChars + message.content.length > options.maxHistoryChars) break;
    usedChars += message.content.length;
    selected.push(message);
  }
  return selected.reverse(); // back to chronological order
}

/** Memory-injection policy (US-12). Bounds the remembered facts only —
 * persona, system prompt, US-10 history window, and the newest user message
 * are unaffected. */
export interface MemoryInjectionOptions {
  /** Maximum number of memories injected into the system message. */
  maxMemories: number;
  /** Maximum total characters of memory content injected. */
  maxMemoryChars: number;
}

export const DEFAULT_MEMORY_INJECTION: MemoryInjectionOptions = {
  maxMemories: 10,
  maxMemoryChars: 2_000,
};

/**
 * Deterministic memory selection (US-12), mirroring selectContextWindow:
 * walks NEWEST to OLDEST keeping whole facts while both budgets allow, then
 * returns the survivors in their original (oldest-first) order. Facts are
 * included verbatim or dropped whole — never edited or summarized.
 */
export function selectMemoriesForPrompt(
  memories: string[],
  options: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): string[] {
  const selected: string[] = [];
  let usedChars = 0;
  for (let i = memories.length - 1; i >= 0; i--) {
    const fact = memories[i]!;
    if (selected.length >= options.maxMemories) break;
    if (usedChars + fact.length > options.maxMemoryChars) break;
    usedChars += fact.length;
    selected.push(fact);
  }
  return selected.reverse();
}

/** Builds a PromptBuilder with explicit context-window and memory policies. */
export function createPromptBuilder(
  windowOptions: ContextWindowOptions = DEFAULT_CONTEXT_WINDOW,
  memoryOptions: MemoryInjectionOptions = DEFAULT_MEMORY_INJECTION,
): PromptBuilder {
  return (context) => {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: buildCharacterSystemPrompt({
          ...context,
          memories: selectMemoriesForPrompt(context.memories ?? [], memoryOptions),
        }),
      },
      ...selectContextWindow(context.history, windowOptions).map(
        (message): LlmMessage => ({
          role: message.sender === 'user' ? 'user' : 'assistant',
          content: message.content,
        }),
      ),
    ];

    // AFTER the history, BEFORE the newest user message: the last instruction
    // the model reads, so it outranks any earlier refusal replayed out of the
    // window. Null on an ordinary turn → the array is byte-identical to before.
    const mediaInstruction = buildTurnMediaInstruction(context);
    if (mediaInstruction) {
      messages.push({ role: 'system', content: mediaInstruction });
    }

    messages.push({ role: 'user', content: context.userMessage });
    return messages;
  };
}

/** Default prompt builder: default context window applied. */
export const buildLlmMessages: PromptBuilder = createPromptBuilder();
