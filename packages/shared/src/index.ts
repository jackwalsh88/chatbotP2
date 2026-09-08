/**
 * @over18/shared
 *
 * Shared TypeScript types used by both the web frontend and the API.
 * Domain types (User, Character, Conversation, Message, ...) will be added
 * here in later stories so that web and api never drift apart.
 */

export {
  detectMediaRequest,
  deriveMediaContext,
  FOLLOW_UP_WINDOW_MESSAGES,
  type MediaContextMessage,
  type MediaRequestContext,
  type MediaRequestType,
} from './mediaRequest.js';

/** Response shape of GET /health on the API. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

/** Generic API error envelope (will be formalised in later stories). */
export interface ApiError {
  error: string;
  message: string;
}

/** Safe, public representation of an authenticated user. Never includes password_hash. */
export interface AuthUser {
  id: string;
  email: string;
  /**
   * Authorization role. The API already returns this (users.role, shipped with
   * US-103); this only mirrors the existing response so the client can gate the
   * admin entry point. Server-side checks remain the security boundary.
   */
  role: 'user' | 'admin';
}

/** Request body for POST /api/auth/register and POST /api/auth/login. */
export interface AuthCredentials {
  email: string;
  password: string;
}

/** Password policy shared by client-side and server-side validation. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt input limit

/**
 * A user's conversation with a character, as returned by the conversations
 * API. Always scoped to the authenticated user — never contains other
 * users' data.
 */
export interface ConversationSummary {
  id: string;
  character: PublicCharacter;
  createdAt: string;
}

/**
 * Media a character message can carry (Character Media Messages, commit 1).
 *
 * Deliberately just a type and an opaque locator. It carries NO asset id, NO
 * storage key, NO provenance and NO filesystem path — `url` is a
 * message-scoped API route, and reading it is authorised by the caller owning
 * the conversation that message belongs to. Nothing about the underlying
 * Library asset is inferable from it.
 */
export type ChatMediaType = 'image' | 'video';

export interface ChatMessageMedia {
  type: ChatMediaType;
  /** Opaque display locator: GET it to receive the bytes. */
  url: string;
}

/**
 * A single chat message inside a conversation (US-07).
 *
 * `media` is OPTIONAL and is OMITTED entirely when a message carries none, so
 * every message that exists today serialises byte-for-byte as it did before.
 */
export interface ChatMessage {
  id: string;
  sender: 'user' | 'character';
  content: string;
  createdAt: string;
  media?: ChatMessageMedia;
}

/** Result of sending a message: both persisted messages, in order. */
export interface SendMessageResult {
  userMessage: ChatMessage;
  characterMessage: ChatMessage;
}

/** Message content limits shared by client- and server-side validation. */
export const MESSAGE_MAX_LENGTH = 2000;

/**
 * Public representation of a character, as returned by GET /api/characters.
 * Internal fields (system_prompt, status) are never included.
 */
export interface PublicCharacter {
  id: string;
  name: string;
  displayName: string;
  profileImage: string | null;
  shortBio: string;
  personality: string;
  interests: string[];
  conversationStyle: string;
}

/**
 * Visual DNA (US-16A) — the IDENTITY-only description of a character's visual
 * self. Deliberately flexible: individual attributes are open-ended strings /
 * nested shapes because the taxonomy is not yet proven. Two rules are firm:
 *  1. `apparentAgeBand` is required and must denote an adult.
 *  2. PRESENTATION attributes (hairstyle, makeup, clothing, accessories, pose,
 *     expression, environment, lighting, camera, composition, photographicStyle)
 *     must NEVER appear here — they are a generation-time concern recorded in a
 *     generated asset's provenance. This identity-vs-presentation separation is
 *     a core architectural principle.
 *
 * This is identity metadata used to compose future generation requests; it is
 * NOT itself secret, but it is not exposed through any existing public wire
 * mapper in US-16A (no visual endpoints exist yet).
 */
export interface VisualDna {
  /** Required. Must denote an adult (e.g. "adult", "adult-20s"). Non-adult is rejected. */
  apparentAgeBand: string;
  face?: unknown;
  eyes?: unknown;
  nose?: unknown;
  lips?: unknown;
  skin?: unknown;
  hair?: unknown;
  body?: unknown;
  distinctiveFeatures?: unknown;
  /** Open-ended room for additional identity attributes as the taxonomy matures. */
  [key: string]: unknown;
}

/**
 * Public, display-ready Visual Identity projection (US-16B).
 * A strict allow-list of the active identity version — it NEVER carries
 * provenance, content-rating internals, draft/retired state, storage details,
 * or any raw jsonb. `attributes` is a curated, ordered set of identity
 * descriptors rendered server-side from the Visual DNA allow-list.
 */
export interface PublicVisualIdentityAttribute {
  label: string;
  value: string;
}

export interface PublicVisualIdentity {
  characterId: string;
  version: number;
  label: string | null;
  attributes: PublicVisualIdentityAttribute[];
}

/**
 * Public, display-ready canonical reference asset (US-16B). Only approved
 * canonical references are ever projected. Carries only what the gallery needs
 * — never kind/status/is_canonical/provenance/content_rating/approver.
 * `imageUrl` is an opaque display locator (a placeholder URL in the PoC; a
 * future StorageProvider resolves it identically).
 */
export interface PublicVisualAsset {
  id: string;
  position: number | null;
  imageUrl: string;
}

/**
 * Response of GET /api/characters/:characterId/visual-identity.
 * `identity` is null (with an empty gallery) when the character has no active
 * visual identity — the clean empty state.
 */
export interface CharacterVisualIdentityResponse {
  identity: PublicVisualIdentity | null;
  canonicalAssets: PublicVisualAsset[];
}

/**
 * Phase 2 — avatar-derived character persona.
 *
 * WHO SHE IS / HER VOICE has always been correct but thin: shortBio,
 * personality and a handful of interests. This is a richer, structured
 * identity layer generated once from a character's avatar, persisted, and
 * compiled deterministically into the same two prompt sections — never a
 * third. It is IDENTITY data, exactly like VisualDna and characters.shortBio:
 * it says who she is, never how she talks. conversationStyle and the stored
 * systemPrompt remain excluded from the model for the same reason they always
 * were — see prompt-builder.ts.
 *
 * Every field is optional and every field is fictional-character DATA, not
 * free-form prose: the compiler (character-persona-compiler.ts) is what turns
 * this into sentences, so nothing generated here can inject its own prompt
 * structure. Internal / admin-facing only, like AdminCharacter's systemPrompt
 * — there is no public wire mapper for this type.
 */
export interface CharacterPersona {
  age?: number;
  ageRange?: string;
  lifeStage?: string;

  occupation?: string;
  education?: string;

  visualStyle?: string;
  demeanor?: string[];

  interests?: string[];
  hobbies?: string[];

  dailyContext?: string[];
  recurringConcerns?: string[];

  socialStyle?: string;
  humorStyle?: string;
  flirtingStyle?: string;

  speechRegister?: string;

  backgroundNotes?: string[];
  relationshipToWorkOrSchool?: string;

  /** Short note on what the image visibly supports, for admin review only. Never rendered into a prompt. */
  sourceSummary?: string;
}

/* ------------------------------------------------------------------ *
 * Home banners (US-102.3)
 * ------------------------------------------------------------------ */

/**
 * Banner lifecycle and eligibility rules, shared by the API and the admin UI.
 *
 * These live in @over18/shared rather than in either app because both sides
 * genuinely need the same answer: the server decides what is publicly eligible,
 * and the editor's live preview has to say what the app will do RIGHT NOW while
 * the operator is still typing. Two implementations of one state machine would
 * drift, and the drift would show up as a preview that lies.
 */

export const BANNER_STATUSES = ['draft', 'published', 'unpublished'] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];

export const BANNER_DESTINATION_KINDS = ['category', 'character', 'content', 'external'] as const;
export type BannerDestinationKind = (typeof BANNER_DESTINATION_KINDS)[number];

/**
 * MVP audience model, deliberately three values and no engine.
 * Demographic and geographic targeting are deferred to US-102.5 — do not add
 * fields here for them; that ticket owns the model they need.
 */
export const BANNER_AUDIENCES = ['everyone', 'new_users', 'returning_users'] as const;
export type BannerAudience = (typeof BANNER_AUDIENCES)[number];

/**
 * Where on Home a banner renders (US-102.4).
 *
 * Two fixed slots, each holding any number of banners in explicit order.
 * Placement belongs to Home composition, which is why the concept arrives with
 * 102.4: 102.3 deliberately owned the banners and their eligibility and left
 * "where does this appear" to the ticket that owns the page.
 */
export const HOME_BANNER_SLOTS = ['before_search', 'below_results'] as const;
export type HomeBannerSlot = (typeof HOME_BANNER_SLOTS)[number];

/**
 * What a banner is doing right now. Derived on every read from status, the
 * schedule window and whether its dependencies still resolve — never stored,
 * because a stored flag goes stale the moment a category is re-enabled and
 * would then need a repair job of its own.
 */
export type BannerState =
  | 'draft'
  | 'scheduled'
  | 'live'
  | 'ended'
  | 'unpublished'
  | 'needs_attention';

/** Why a banner cannot be shown, when its state is needs_attention. */
export type BannerProblem =
  | 'creative_missing'
  | 'creative_invalid'
  | 'destination_missing'
  | 'destination_unavailable'
  | 'destination_invalid_url';

export interface BannerStateInput {
  status: BannerStatus;
  /** ISO instants. Null means "no bound on this side". */
  startsAt: string | null;
  endsAt: string | null;
  /** Everything wrong with this banner right now; empty when it is healthy. */
  problems: readonly BannerProblem[];
}

/**
 * The one state machine.
 *
 * Boundary semantics are explicit and inclusive-start/exclusive-end:
 *   now  <  startsAt   → scheduled
 *   now  >= startsAt and now < endsAt → live
 *   now  >= endsAt     → ended
 *
 * PROBLEMS OUTRANK EVERYTHING published. A banner whose destination or creative
 * has broken is `needs_attention` whether or not its window is open, so it can
 * never be publicly eligible while broken — but a DRAFT with problems is still
 * just a draft, because an operator part-way through building one has not
 * asserted anything yet and does not need a warning chip for it.
 *
 * IT FAILS CLOSED. A bound that is present but unreadable cannot be compared,
 * and every comparison against NaN is false — so the naive form of this
 * function falls through to `live` and shows a banner forever on the strength
 * of one corrupt timestamp. A window that cannot be read is treated as a broken
 * banner instead. This is the primitive public eligibility is gated on, so its
 * behaviour on data it does not understand has to be "do not show it".
 */
function scheduleBound(value: string | null): number | null | 'unreadable' {
  if (value === null) return null;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? 'unreadable' : instant;
}

export function bannerEffectiveState(banner: BannerStateInput, now: Date): BannerState {
  if (banner.status === 'draft') return 'draft';
  if (banner.status === 'unpublished') return 'unpublished';

  if (banner.problems.length > 0) return 'needs_attention';

  const startsAt = scheduleBound(banner.startsAt);
  const endsAt = scheduleBound(banner.endsAt);
  if (startsAt === 'unreadable' || endsAt === 'unreadable') return 'needs_attention';

  const instant = now.getTime();
  if (startsAt !== null && instant < startsAt) return 'scheduled';
  if (endsAt !== null && instant >= endsAt) return 'ended';
  return 'live';
}

/** Only a live banner may be shown publicly. Nothing else, ever. */
export function isBannerPubliclyEligible(banner: BannerStateInput, now: Date): boolean {
  return bannerEffectiveState(banner, now) === 'live';
}

/** Who is looking. The ONLY viewer fact the MVP audience model consults. */
export interface BannerViewer {
  /** False for a first-time/newly registered visitor, true for a returning one. */
  isReturning: boolean;
}

/**
 * Audience matching, MVP.
 *
 * Deliberately a two-line function over one boolean rather than a predicate
 * engine: US-102.5 will replace this wholesale, and a general segmentation
 * layer built now would be the wrong shape and would have to be unbuilt.
 *
 * Note what is NOT here: the definition of "returning". That is a property of
 * the public request, which US-102.4 owns.
 */
export function audienceMatches(audience: BannerAudience, viewer: BannerViewer): boolean {
  if (audience === 'everyone') return true;
  return audience === 'returning_users' ? viewer.isReturning : !viewer.isReturning;
}
