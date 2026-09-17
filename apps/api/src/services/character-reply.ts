import type { CharacterPersona, ChatMessage, PublicCharacter } from '@over18/shared';

/**
 * Reply-provider seam (US-07, extended in US-08).
 *
 * This interface is the ONLY contract the message service depends on for
 * producing a character's response. Implementations:
 * - deterministicReplyProvider (below): US-07 placeholder, still the
 *   fallback when no inference endpoint is configured.
 * - createLlmReplyProvider (llm-reply-provider.ts): US-08, backed by a
 *   swappable LlmClient adapter.
 *
 * systemPrompt and history exist ONLY server-side inside this context —
 * they are never serialized into any API response.
 */
export interface ReplyContext {
  character: PublicCharacter;
  /** Internal persona instructions from the DB. Never exposed on the wire. */
  systemPrompt: string;
  /** Prior messages in the conversation, oldest first (excludes the new user message). */
  history: ChatMessage[];
  /** Number of messages already in the conversation before this exchange. */
  priorMessageCount: number;
  userMessage: string;
  /**
   * Durable facts remembered about this user for THIS character (US-12),
   * oldest first. Strictly (user, character)-scoped — never crosses
   * characters. Server-side only, like systemPrompt: never on the wire.
   * Optional so existing ReplyProvider callers/fixtures stay source-compatible.
   */
  memories?: string[];
  /**
   * Phase 2 — avatar-derived identity data, if a persona has been generated
   * for this character. Rendered into WHO SHE IS / HER VOICE only (see
   * prompt-builder.ts's compilePersonaWhoSheIs/compilePersonaVoiceClause);
   * never exposed on the wire. Optional/nullable so existing ReplyProvider
   * callers and fixtures stay source-compatible.
   */
  persona?: CharacterPersona | null;
  /**
   * Set when the server has ALREADY decided to attach media to this reply, and
   * to which kind. Null/absent on every ordinary turn.
   *
   * This exists to stop the reply contradicting the action. Selection now runs
   * BEFORE the reply is generated, so without this the model writes blind and
   * can refuse ("I don't send pics to guys I haven't met…") while the server
   * attaches a picture anyway — exactly what the first POC test produced.
   *
   * Strictly one-way: the model is TOLD what is being sent. It cannot choose
   * the asset, cannot see its id, storage key, path or URL, and cannot ask for
   * media that was not already selected by the server's own rules.
   */
  sendingMedia?: 'image' | 'video' | null;
  /**
   * Set when the person explicitly asked for media and the server had NOTHING
   * eligible to send. Mutually exclusive with sendingMedia by construction.
   *
   * This used to be indistinguishable from an ordinary turn, on the reasoning
   * that silence was safest. It was not: with no guidance the model wrote a
   * flat refusal, and that refusal then sat in the conversation history and was
   * replayed on every later turn — including turns where media WAS attached.
   * One dead end became a permanent character trait.
   *
   * Telling the provider explicitly lets it answer honestly about this one
   * moment without committing the character to refusing in future.
   */
  requestedMediaUnavailable?: 'image' | 'video' | null;
}

export type ReplyProvider = (context: ReplyContext) => Promise<string> | string;

/**
 * Deterministic, in-character placeholder replies built purely from the
 * character's public persona (display name, bio, personality, interests,
 * conversation style). Same inputs → same reply, which keeps tests stable
 * and the demo predictable.
 */
export const deterministicReplyProvider: ReplyProvider = ({
  character,
  priorMessageCount,
  sendingMedia,
  requestedMediaUnavailable,
}) => {
  const interests = character.interests.length > 0 ? character.interests : ['getting to know you'];
  const interest = interests[Math.floor(priorMessageCount / 2) % interests.length]!;

  // When the server has already decided to attach media, the text must AGREE
  // with that. A refusal here would contradict a picture the user can see.
  if (sendingMedia) {
    return sendingMedia === 'video'
      ? `Okay — here's a little video, just for you.`
      : `Okay — here's a picture of me, just for you.`;
  }

  // Asked, nothing to send. Honest about right now, deliberately NOT a rule
  // about the character — "not right now" leaves later turns free, where
  // "I don't send those" would poison them.
  if (requestedMediaUnavailable) {
    return requestedMediaUnavailable === 'video'
      ? `Not right now — I'm not in the mood to film anything. Ask me again sometime.`
      : `Not right now — I'm not in the mood for pictures. Ask me again sometime.`;
  }

  const templates = [
    `Hey, I'm ${character.displayName}. ${character.shortBio} I'm really glad you're here — tell me something about yourself?`,
    `Mm, I like that. You know, I've been really into ${interest} lately — does that world mean anything to you?`,
    `That makes me smile. People say I'm ${firstClause(character.personality)} — I think you'd find out quickly whether they're right.`,
    `Tell me more. I promise I'm listening — ${firstClause(character.conversationStyle)} is kind of my thing.`,
    `I was just thinking about ${interest} before you wrote. Funny timing. What's pulling at your thoughts today?`,
  ];

  return templates[priorMessageCount % templates.length]!;
};

/** First clause of a sentence, lowercased — turns persona prose into something quotable. */
function firstClause(text: string): string {
  const clause = text.split(/[.,—]/)[0]?.trim() ?? text.trim();
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}
