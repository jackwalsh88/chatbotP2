import { asc, eq } from 'drizzle-orm';
import type { ChatMediaType, ChatMessage, SendMessageResult } from '@over18/shared';
import type { Db } from '../db/client.js';
import {
  characterPersonas,
  characters,
  characterVisualAssets,
  conversations,
  messages,
  type MessageRow,
} from '../db/schema.js';
import { mediaTypeOf } from './content-review-service.js';
import {
  mediaUrlFor,
  type MediaSelector,
  type SelectedMedia,
} from './message-media-service.js';
import { getConversationForUser } from './conversation-service.js';
import { deterministicReplyProvider, type ReplyProvider } from './character-reply.js';
import { noopMemoryExtractor, type MemoryExtractor } from './memory-extractor.js';
import { DEFAULT_MEMORY_MAX_STORED, listMemories, storeMemories } from './memory-service.js';

/**
 * Message service (US-07). Transport-agnostic; ownership is enforced by
 * resolving the conversation through the same owner-scoped lookup US-06
 * established — callers with no access simply see null.
 */

/** US-12 memory hook configuration for sendMessage. */
export interface MemoryHookOptions {
  extractor: MemoryExtractor;
  /** Per-(user, character) storage cap; oldest facts evicted beyond it. */
  maxStored: number;
  /** Called when extraction/storage fails; the failure is otherwise swallowed. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_MEMORY_HOOK: MemoryHookOptions = {
  extractor: noopMemoryExtractor,
  maxStored: DEFAULT_MEMORY_MAX_STORED,
};

/**
 * Character Media Messages hook (commit 2) — the seam through which a character
 * reply may carry media. Modelled on the memory hook above deliberately: an
 * optional capability injected into sendMessage, not a change to how replies
 * are produced.
 *
 * The ReplyProvider contract is UNCHANGED and stays a plain
 * `(context) => Promise<string>`. The model does not choose the asset, is not
 * told one was chosen, and cannot emit an id, URL or path. Selection is a
 * separate server-side decision made from `requested`, which comes from an
 * explicit API flag — never from parsing the user's text.
 *
 * Media is attached ONLY when BOTH are present: a selector (absent when the
 * feature flag is off) and a `requested` type (absent unless the request
 * explicitly asked). Either missing → the exact prior text-only behaviour.
 */
export interface MediaHookOptions {
  /** Null when CHAT_MEDIA_ENABLED is off — no selection is even attempted. */
  selector?: MediaSelector | null;
  /** Which media the caller explicitly asked for; null for an ordinary send. */
  requested?: ChatMediaType | null;
  /** Called when selection fails. The exchange proceeds as text-only. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_MEDIA_HOOK: MediaHookOptions = { selector: null, requested: null };

/**
 * Wire mapper. Media-aware and additive: when a row carries no media asset the
 * `media` key is omitted entirely rather than set to null/undefined, so a
 * text-only message serialises byte-for-byte as it did before this feature.
 *
 * `mediaType` is resolved by the caller from the joined asset row; this mapper
 * never sees the asset id, storage key or provenance, and emits only an opaque
 * message-scoped URL.
 */
function toChatMessage(row: MessageRow, mediaType?: ChatMediaType | null): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    sender: row.sender,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.mediaAssetId !== null && mediaType) {
    message.media = { type: mediaType, url: mediaUrlFor(row.conversationId, row.id) };
  }
  return message;
}

/**
 * Full message history, oldest first. Null when the conversation isn't the
 * caller's.
 *
 * LEFT JOIN, deliberately: a message whose media asset was deleted from the
 * Library (media_asset_id is ON DELETE SET NULL) — or which never had one, i.e.
 * all of them today — must still return its text. Media can never make a
 * message disappear from history.
 */
export async function listMessages(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<ChatMessage[] | null> {
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return null;
  const rows = await db
    .select({ message: messages, asset: characterVisualAssets })
    .from(messages)
    .leftJoin(characterVisualAssets, eq(characterVisualAssets.id, messages.mediaAssetId))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq));
  return rows.map((row) =>
    toChatMessage(
      row.message,
      row.asset ? mediaTypeOf(row.asset.storageKey, row.asset.provenance) : null,
    ),
  );
}

/**
 * Sends a user message and produces the character's reply ATOMICALLY:
 * user message insert, reply generation, character message insert, and the
 * conversation's updated_at bump all happen in one transaction — if any
 * step fails the whole exchange rolls back and nothing persists.
 *
 * Null when the conversation isn't the caller's.
 */
export async function sendMessage(
  db: Db,
  userId: string,
  conversationId: string,
  content: string,
  replyProvider: ReplyProvider = deterministicReplyProvider,
  memory: MemoryHookOptions = DEFAULT_MEMORY_HOOK,
  media: MediaHookOptions = DEFAULT_MEDIA_HOOK,
): Promise<SendMessageResult | null> {
  const conversation = await getConversationForUser(db, userId, conversationId);
  if (!conversation) return null;

  const result = await db.transaction(async (tx) => {
    // Full prior history (oldest first) — the LLM provider needs it, and its
    // length doubles as the deterministic provider's message counter.
    const historyRows = await tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.seq));

    // Internal persona instructions — read server-side only, never on the wire.
    const [personaRow] = await tx
      .select({ systemPrompt: characters.systemPrompt })
      .from(characters)
      .where(eq(characters.id, conversation.character.id));

    // US-12: remembered facts for THIS (user, character) pair only, oldest
    // first. Like systemPrompt, they exist purely server-side in the context.
    const rememberedFacts = await listMemories(tx, userId, conversation.character.id);

    // Phase 2: avatar-derived persona, if one has been generated. Null for
    // every character today (the table is new) — read the same way as
    // systemPrompt, server-side only, never on the wire.
    const [avatarPersonaRow] = await tx
      .select({ persona: characterPersonas.persona })
      .from(characterPersonas)
      .where(eq(characterPersonas.characterId, conversation.character.id));

    const [userRow] = await tx
      .insert(messages)
      .values({ conversationId, sender: 'user', content })
      .returning();

    // Media selection runs BEFORE the reply is generated.
    //
    // The order matters and was wrong at first: generating text first meant the
    // model wrote blind and could refuse ("I don't send pics…") while the
    // server attached a picture regardless. Selecting first lets the outcome be
    // passed into the reply context, so the words and the attachment agree.
    //
    // Still INSIDE the transaction, so the "already sent in this conversation"
    // exclusion sees a consistent view and the asset is written in the SAME
    // insert as the reply — no window where a message exists without its media.
    //
    // Both conditions are required: a selector (null when the feature flag is
    // off) and an explicit requested type. Neither can be produced by the model.
    // True only when the feature is on AND the caller explicitly asked. With
    // the feature off, a stray requestMedia is not a media turn at all.
    const mediaWasRequested = Boolean(media.selector && media.requested);
    let selected: SelectedMedia | null = null;
    if (media.selector && media.requested) {
      try {
        selected = await media.selector(tx, {
          characterId: conversation.character.id,
          conversationId,
          requested: media.requested,
        });
      } catch (error) {
        // Never fail a chat exchange over media. Degrade to text and report.
        media.onError?.(error);
        selected = null;
      }
    }

    const replyText = await replyProvider({
      character: conversation.character,
      systemPrompt: personaRow!.systemPrompt,
      persona: avatarPersonaRow?.persona ?? null,
      // Explicit arrow, NOT a point-free `.map(toChatMessage)`: map passes the
      // index as the second argument, which is the media-type parameter.
      // The model's history is text-only.
      history: historyRows.map((row) => toChatMessage(row)),
      priorMessageCount: historyRows.length,
      userMessage: content,
      memories: rememberedFacts,
      // Null unless an asset was actually selected — the character never
      // promises media that is not attached.
      sendingMedia: selected?.mediaType ?? null,
      // ...and when they DID ask but nothing was eligible, say so explicitly
      // rather than letting it look like an ordinary turn. Silence there is
      // what produced the first flat refusal, which the history window then
      // replayed into every later turn. See ReplyContext.
      requestedMediaUnavailable: mediaWasRequested && !selected ? media.requested! : null,
    });

    const [characterRow] = await tx
      .insert(messages)
      .values({
        conversationId,
        sender: 'character',
        content: replyText,
        mediaAssetId: selected?.assetId ?? null,
      })
      .returning();

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return {
      userMessage: toChatMessage(userRow!),
      // Text and media are one response: the same message row carries both, so
      // the client reveals them together under the existing timing rules.
      characterMessage: toChatMessage(characterRow!, selected?.mediaType ?? null),
    };
  });

  // US-12 memory extraction — strictly AFTER the exchange has committed, so
  // it can never break or roll back a successful chat exchange. Any failure
  // here (extractor or storage) is reported via onError and swallowed: the
  // worst case is that this exchange's facts are not remembered.
  try {
    const facts = await memory.extractor({
      character: conversation.character,
      userMessage: content,
    });
    if (facts.length > 0) {
      await storeMemories(db, userId, conversation.character.id, facts, memory.maxStored);
    }
  } catch (error) {
    memory.onError?.(error);
  }

  return result;
}
