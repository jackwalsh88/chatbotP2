import type {
  ApiError,
  AuthCredentials,
  AuthUser,
  BannerAudience,
  BannerDestinationKind,
  BannerProblem,
  BannerState,
  BannerStatus,
  HomeBannerSlot,
  ChatMessage,
  CharacterVisualIdentityResponse,
  ConversationSummary,
  HealthResponse,
  PublicCharacter,
  SendMessageResult,
} from '@over18/shared';

/**
 * Single entry point for talking to the Over18 REST API.
 * The frontend never accesses the database directly — everything goes through
 * this client. All requests are credentialed so the HttpOnly session cookie
 * flows automatically; no tokens are ever stored in localStorage.
 */
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Error carrying the API's error envelope plus HTTP status. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export const charactersApi = {
  list(): Promise<PublicCharacter[]> {
    return request<PublicCharacter[]>('/api/characters');
  },
  get(characterId: string): Promise<PublicCharacter> {
    return request<PublicCharacter>(`/api/characters/${encodeURIComponent(characterId)}`);
  },
  /** US-16B: public visual identity + approved canonical gallery for a character. */
  visualIdentity(characterId: string): Promise<CharacterVisualIdentityResponse> {
    return request<CharacterVisualIdentityResponse>(
      `/api/characters/${encodeURIComponent(characterId)}/visual-identity`,
    );
  },
  /**
   * Her CONTENT collection — every publicly reachable clip she has, in full.
   *
   * Distinct from `visualIdentity`, which returns her canonical REFERENCE
   * images. Identity is who she is; this is what she has posted, and the Posts
   * tab must never substitute one for the other.
   */
  clips(characterId: string): Promise<{ clips: PublicClip[] }> {
    return request<{ clips: PublicClip[] }>(
      `/api/characters/${encodeURIComponent(characterId)}/clips`,
    );
  },
};

export const conversationsApi = {
  /** Creates the conversation with a character, or reopens the existing one. */
  start(characterId: string): Promise<ConversationSummary> {
    return request<ConversationSummary>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    });
  },
  get(conversationId: string): Promise<ConversationSummary> {
    return request<ConversationSummary>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
    );
  },
};

export const messagesApi = {
  list(conversationId: string): Promise<ChatMessage[]> {
    return request<ChatMessage[]>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  },
  /**
   * `requestMedia` is the explicit, deliberate trigger for a character to send
   * media. It is OMITTED for ordinary sends — including every send the chat UI
   * makes today — so normal conversation is never altered. The server ignores
   * it unless CHAT_MEDIA_ENABLED is on, and the server, never the model,
   * decides which asset is sent.
   */
  send(
    conversationId: string,
    content: string,
    requestMedia?: 'image' | 'video',
  ): Promise<SendMessageResult> {
    return request<SendMessageResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(requestMedia ? { content, requestMedia } : { content }),
      },
    );
  },
};

export const authApi = {
  register(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  login(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  me(): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/me');
  },
};

/** US-106 — admin content review. Uses the same session-cookie request helper. */
export interface ReviewAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  status: 'generated' | 'under_review' | 'approved' | 'rejected';
  contentRating: 'sfw' | 'explicit';
  /** The configured content requirement this item is filed under, if any. */
  requirementKey: string | null;
  isPrimary: boolean;
  /**
   * Opaque media locator (`/admin/content/assets/<id>/file`), or null when the
   * asset has no bytes. Replaced `storageKey`, which leaked the server's
   * filesystem path for generated assets and was a broken URL for them too.
   */
  previewUrl: string | null;
  createdAt: string;
  approvedAt: string | null;
  provenance: {
    jobId: string | null;
    provider: string | null;
    model: string | null;
    generatedAt: string | null;
  };
}

export interface CharacterReviewSummary {
  characterId: string;
  characterName: string;
  pendingCount: number;
}

export interface LibraryAssetView extends ReviewAssetView {
  recencyBasis: 'approved' | 'added';
  recentAt: string;
}

export const contentLibraryApi = {
  list: (
    params: {
      characterId?: string;
      mediaType?: 'image' | 'video';
      search?: string;
      /**
       * An explicit status. The Library shows APPROVED content by default, so
       * a just-uploaded clip — which is `under_review` — is legitimately absent
       * from it. Passing the status is how a caller asks for the items that are
       * still waiting, using the filter the route has always accepted.
       */
      status?: 'generated' | 'under_review' | 'approved' | 'rejected';
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.characterId) q.set('characterId', params.characterId);
    if (params.mediaType) q.set('mediaType', params.mediaType);
    if (params.search) q.set('search', params.search);
    if (params.status) q.set('status', params.status);
    const suffix = q.toString() ? `?${q}` : '';
    return request<{ recent: LibraryAssetView[]; assets: LibraryAssetView[]; filtered: boolean }>(
      `/admin/content/library${suffix}`,
    );
  },
  /**
   * Manual upload of one existing image/video file. Sent as multipart/form-data,
   * so the Content-Type header is left to the browser (it must supply the
   * boundary) — that is why this cannot use the JSON `request` helper.
   */
  upload: async (
    file: File,
    characterId: string,
    options: {
      /** 'sfw' is Regular, 'explicit' is Explicit. Omitted, the server defaults. */
      contentRating?: 'sfw' | 'explicit';
      /**
       * Which Character-page shelf this upload came from.
       *
       * The client names a SHELF and nothing else. The server derives the
       * asset's kind, its approval and which media types it will accept — a
       * browser can never say `kind`, because `kind` is what decides whether an
       * asset can reach a public surface or a private conversation.
       *
       * Omitted is the Content Library, which still queues for Review exactly
       * as it always has.
       */
      section?: 'regular' | 'explicit' | 'chat';
    } = {},
  ): Promise<LibraryAssetView> => {
    const form = new FormData();
    form.append('characterId', characterId);
    if (options.contentRating) form.append('contentRating', options.contentRating);
    if (options.section) form.append('section', options.section);
    form.append('file', file);
    const res = await fetch(`${API_URL}/admin/content/uploads`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      let code = 'request_failed';
      let message = `Upload failed (${res.status}).`;
      try {
        const body = (await res.json()) as Partial<ApiError>;
        if (body.error) code = body.error;
        if (body.message) message = body.message;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      throw new ApiRequestError(res.status, code, message);
    }
    return (await res.json()) as LibraryAssetView;
  },
  /** Permanently deletes a Library asset and its stored file. */
  remove: (assetId: string) =>
    request<{ assetId: string; fileRemoved: boolean; fileWasMissing: boolean }>(
      `/admin/content/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),
};

/* ------------------------------------------------------------------ *
 * Configurable content requirements
 *
 * Every category and quantity below arrives from the server. Nothing in this
 * application declares what a character needs — that lives in configuration.
 * ------------------------------------------------------------------ */

export type MediaTypeName = 'image' | 'video';

export interface ContentRequirementView {
  id: string;
  key: string;
  label: string;
  mediaType: MediaTypeName;
  requiredQuantity: number;
  /** Advisory policy, never a filter on what counts. */
  contentRating: 'sfw' | 'explicit' | null;
  enabled: boolean;
  assignPrimaryReference: boolean;
  position: number;
}

export interface ContentRequirementRowView extends ContentRequirementView {
  /** How many items are filed under this key — why deleting may be refused. */
  assignedAssetCount: number;
}

export interface RequirementTotals {
  items: number;
  images: number;
  videos: number;
}

export interface CharacterProgressView {
  characterId: string;
  characterName: string;
  displayName: string;
  required: number;
  approved: number;
  pending: number;
  missing: number;
  complete: boolean;
}

export interface RequirementEntryView {
  key: string;
  label: string;
  mediaType: MediaTypeName;
  contentRating: 'sfw' | 'explicit' | null;
  /** The configured quantity — the board renders this many capacity slots. */
  required: number;
  approved: number;
  pending: number;
  remaining: number;
  surplus: number;
  satisfied: boolean;
  assets: ReviewAssetView[];
}

export type TriageReason = 'uncategorised' | 'unknown_requirement' | 'media_mismatch';

export interface TriageAssetView extends ReviewAssetView {
  reason: TriageReason;
}

export interface ReviewWorkspaceView {
  characters: CharacterProgressView[];
  requirements: ContentRequirementView[];
  inbox: { unassignedCount: number };
  selected: {
    character: { id: string; name: string; displayName: string; status: string };
    totals: { required: number; approved: number; pending: number; missing: number; complete: boolean };
    requirements: RequirementEntryView[];
    triage: TriageAssetView[];
  } | null;
}

export interface InboxItemView {
  inboxId: string;
  status: 'unassigned' | 'assigned' | 'discarded';
  mediaType: MediaTypeName;
  originalName: string | null;
  byteSize: number;
  fileUrl: string | null;
  assignedAssetId: string | null;
  createdAt: string;
}

export interface RequirementDraft {
  label: string;
  mediaType: MediaTypeName;
  requiredQuantity?: number;
  contentRating?: 'sfw' | 'explicit' | null;
  enabled?: boolean;
  assignPrimaryReference?: boolean;
  position?: number;
}

export const contentRequirementsApi = {
  list: () =>
    request<{ requirements: ContentRequirementRowView[]; totals: RequirementTotals }>(
      '/admin/settings/content-requirements',
    ),
  /** What the configuration means for real characters, right now. */
  impact: () =>
    request<{ characters: CharacterProgressView[] }>(
      '/admin/settings/content-requirements/impact',
    ),
  create: (draft: RequirementDraft) =>
    request<ContentRequirementView>('/admin/settings/content-requirements', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (id: string, patch: Partial<RequirementDraft>) =>
    request<ContentRequirementView>(
      `/admin/settings/content-requirements/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  remove: (id: string) =>
    request<void>(`/admin/settings/content-requirements/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

/* ------------------------------------------------------------------ *
 * App Categories (US-102.1)
 * ------------------------------------------------------------------ */

/**
 * A user-facing merchandising category.
 *
 * NOT a content requirement. Requirements describe what must be PRODUCED for a
 * character; these describe how already-approved content is ORGANISED in the
 * app. Separate endpoints, separate tables, no shared field.
 */
export interface AppCategoryView {
  id: string;
  /** Stable internal identity, fixed at creation. Renaming never changes it. */
  slug: string;
  name: string;
  tagline: string | null;
  enabled: boolean;
  position: number;
  /** Library items merchandised here, publishable or not (US-102.2). */
  assignedAssetCount: number;
  /** How many of those are approved right now, i.e. would actually appear. */
  publishableAssetCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppCategoryTotals {
  categories: number;
  enabled: number;
  assignedAssets: number;
}

export interface AppCategoryDraft {
  name: string;
  /** Omitted on create so the server derives it from the name. */
  slug?: string;
  tagline?: string | null;
  enabled?: boolean;
}

export const appCategoriesApi = {
  list: () =>
    request<{ categories: AppCategoryView[]; totals: AppCategoryTotals }>('/admin/app-categories'),
  create: (draft: AppCategoryDraft) =>
    request<AppCategoryView>('/admin/app-categories', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  /** `slug` is deliberately absent: the server refuses it, and so does this. */
  update: (id: string, patch: Partial<Omit<AppCategoryDraft, 'slug'>>) =>
    request<AppCategoryView>(`/admin/app-categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** Returns how many items became unassigned. Never deletes an asset. */
  remove: (id: string) =>
    request<{ deleted: true; releasedAssetCount: number }>(
      `/admin/app-categories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** Whole-list reorder. The server refuses anything but an exact permutation. */
  reorder: (orderedIds: string[]) =>
    request<{ categories: AppCategoryView[] }>('/admin/app-categories/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
};

/* ------------------------------------------------------------------ *
 * Category merchandising (US-102.2)
 * ------------------------------------------------------------------ */

/** One approved asset as it sits inside a category. */
export interface CategoryAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  contentRating: string;
  /** Advisory. Never a reason an item is or is not publishable. */
  isPrimary: boolean;
  status: string;
  position: number;
  featured: boolean;
  /**
   * False when the app would not render this item — it lost approval, its
   * character was retired, it is not content, or it has no file.
   */
  publishable: boolean;
  /** Which rule it fails, or null when it fails none. */
  ineligibleReason: HomeIneligibility | null;
  previewUrl: string | null;
  addedAt: string;
}

/**
 * Why an assigned item cannot appear on Home.
 *
 * Mirrors the API's `HomeIneligibility`. The server decides — this list exists
 * so the operator can be told which rule was hit, not so the client can decide
 * for itself.
 */
export type HomeIneligibility =
  | 'not_approved'
  | 'not_content'
  | 'character_inactive'
  | 'no_media';

/** An approved Library asset offered by the picker. */
export interface CandidateAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  contentRating: string;
  isPrimary: boolean;
  previewUrl: string | null;
  approvedAt: string | null;
  categoryCount: number;
  inThisCategory: boolean;
  /** Assignable, but not renderable yet — usually an unpublished character. */
  ineligibleReason: HomeIneligibility | null;
}

export interface AddOutcome {
  assetId: string;
  added: boolean;
  reason?: 'not_found' | 'already_present' | HomeIneligibility;
  status?: string;
}

export interface CategoryAssetTotals {
  assigned: number;
  publishable: number;
  featured: number;
}

export interface CandidateQuery {
  characterId?: string;
  mediaType?: 'image' | 'video';
  contentRating?: string;
  search?: string;
  categoryId?: string;
  excludeAssigned?: boolean;
}

function queryString(params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const merchandisingApi = {
  /** Resolves the workspace URL's stable slug. */
  categoryBySlug: (slug: string) =>
    request<{
      id: string;
      slug: string;
      name: string;
      tagline: string | null;
      enabled: boolean;
      position: number;
    }>(`/admin/app-categories/by-slug/${encodeURIComponent(slug)}`),

  /** Everything assigned, including items that lost approval (flagged). */
  contents: (categoryId: string) =>
    request<{ assets: CategoryAssetView[]; totals: CategoryAssetTotals }>(
      `/admin/app-categories/${encodeURIComponent(categoryId)}/assets`,
    ),

  /** The picker. Approved content only — enforced server-side. */
  candidates: (query: CandidateQuery = {}) =>
    request<{ assets: CandidateAssetView[] }>(
      `/admin/app-categories/candidates${queryString({ ...query })}`,
    ),

  add: (categoryId: string, assetIds: string[]) =>
    request<{ outcomes: AddOutcome[]; added: number; refused: number }>(
      `/admin/app-categories/${encodeURIComponent(categoryId)}/assets`,
      { method: 'POST', body: JSON.stringify({ assetIds }) },
    ),

  /** Removes links only. The Library asset is never touched. */
  remove: (categoryId: string, assetIds: string[]) =>
    request<{ removed: number }>(
      `/admin/app-categories/${encodeURIComponent(categoryId)}/assets/remove`,
      { method: 'POST', body: JSON.stringify({ assetIds }) },
    ),

  reorder: (categoryId: string, orderedAssetIds: string[]) =>
    request<{ assets: CategoryAssetView[] }>(
      `/admin/app-categories/${encodeURIComponent(categoryId)}/assets/order`,
      { method: 'PUT', body: JSON.stringify({ orderedAssetIds }) },
    ),

  setFeatured: (categoryId: string, assetId: string, featured: boolean) =>
    request<{ assets: CategoryAssetView[] }>(
      `/admin/app-categories/${encodeURIComponent(categoryId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'PATCH', body: JSON.stringify({ featured }) },
    ),
};

/* ------------------------------------------------------------------ *
 * Play with me — a derived rail, presented as a category
 *
 * The board sends the CLIPS it rendered, exactly as it does for a real
 * category. The server maps them to the characters behind them, because that
 * is what the order is keyed on — the clip a character shows is derived and
 * changes when her content does.
 *
 * There is deliberately no add, no remove and no feature: membership is the
 * video rule, not a list an operator edits.
 * ------------------------------------------------------------------ */

/** The reserved slug the categories list pins and the board routes on. */
export const PLAY_WITH_ME_SLUG = 'play-with-me';
export const PLAY_WITH_ME_NAME = 'Play with me';

export interface PlayWithMeContentsState {
  /** True when an operator order is saved; false while the rail is alphabetical. */
  ordered: boolean;
  assets: CategoryAssetView[];
}

export const playWithMeApi = {
  contents: () => request<PlayWithMeContentsState>('/admin/home/play-with-me/contents'),
  reorder: (orderedAssetIds: string[]) =>
    request<PlayWithMeContentsState>('/admin/home/play-with-me/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedAssetIds }),
    }),
  /** Back to alphabetical. Deletes the saved order; touches nothing else. */
  clearOrder: () =>
    request<PlayWithMeContentsState>('/admin/home/play-with-me/order', { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ *
 * Home banners (US-102.3)
 * ------------------------------------------------------------------ */

export interface BannerCreativeView {
  id: string;
  mimeType: string;
  mediaType: 'image' | 'video';
  byteSize: number;
  originalName: string | null;
  /** Advisory. Null when the format did not expose them. */
  width: number | null;
  height: number | null;
  /** Opaque, id-keyed media route. Never a storage path. */
  fileUrl: string;
  createdAt: string;
}

export interface BannerDestinationView {
  kind: BannerDestinationKind;
  categoryId: string | null;
  characterId: string | null;
  assetId: string | null;
  url: string | null;
  /** Resolved server-side. Null when the destination is broken. */
  label: string | null;
}

export interface HomeBannerView {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  creative: BannerCreativeView | null;
  destination: BannerDestinationView;
  status: BannerStatus;
  audience: BannerAudience;
  startsAt: string | null;
  endsAt: string | null;
  scheduleTimezone: string | null;
  /** Which Home slot this banner renders in (US-102.4). */
  slot: HomeBannerSlot;
  position: number;
  publishedAt: string | null;
  /** Derived per read — never stored. See @over18/shared. */
  state: BannerState;
  problems: BannerProblem[];
  createdAt: string;
  updatedAt: string;
}

export interface BannerCreativeRequirements {
  acceptedMimeTypes: string[];
  maxBytes: number;
  maxLabel: string;
  recommendedAspect: string;
  recommendedMinWidth: number;
  dimensionsEnforced: false;
}

export interface BannerDestinationOptions {
  categories: Array<{ id: string; name: string; slug: string }>;
  characters: Array<{ id: string; name: string; displayName: string }>;
  content: Array<{ id: string; characterId: string; characterName: string }>;
}

export interface HomeBannerDraft {
  title: string;
  subtitle?: string | null;
  ctaLabel?: string | null;
  creativeId?: string | null;
  destinationKind: BannerDestinationKind;
  destinationCategoryId?: string | null;
  destinationCharacterId?: string | null;
  destinationAssetId?: string | null;
  destinationUrl?: string | null;
  audience?: BannerAudience;
  slot?: HomeBannerSlot;
  startsAt?: string | null;
  endsAt?: string | null;
  scheduleTimezone?: string | null;
}

export const homeBannersApi = {
  list: () =>
    request<{
      banners: HomeBannerView[];
      totals: { total: number; live: number; scheduled: number; needsAttention: number };
      requirements: BannerCreativeRequirements;
    }>('/admin/home-banners'),
  get: (id: string) => request<HomeBannerView>(`/admin/home-banners/${encodeURIComponent(id)}`),
  /** Always creates a DRAFT — the server ignores any status sent. */
  create: (draft: HomeBannerDraft) =>
    request<HomeBannerView>('/admin/home-banners', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  /** Never changes lifecycle state; publish/unpublish are separate actions. */
  update: (id: string, patch: Partial<HomeBannerDraft>) =>
    request<HomeBannerView>(`/admin/home-banners/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  publish: (id: string) =>
    request<HomeBannerView>(`/admin/home-banners/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
    }),
  unpublish: (id: string) =>
    request<HomeBannerView>(`/admin/home-banners/${encodeURIComponent(id)}/unpublish`, {
      method: 'POST',
    }),
  /** Deletes the banner only — the creative row and file survive. */
  remove: (id: string) =>
    request<{ deleted: true; creativeKept: true }>(
      `/admin/home-banners/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** US-102.4: ordering is per SLOT — position is an order within a slot. */
  reorder: (slot: HomeBannerSlot, orderedIds: string[]) =>
    request<{ banners: HomeBannerView[] }>('/admin/home-banners/order', {
      method: 'PUT',
      body: JSON.stringify({ slot, orderedIds }),
    }),
  destinations: () => request<BannerDestinationOptions>('/admin/home-banners/destinations'),
  requirements: () =>
    request<BannerCreativeRequirements>('/admin/home-banners/creative-requirements'),
  /**
   * Uploads a dedicated banner creative. Multipart, so it bypasses `request`'s
   * JSON handling — the same shape the Library upload client uses.
   */
  async uploadCreative(file: File): Promise<BannerCreativeView> {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${API_URL}/admin/home-banners/creatives`, {
      method: 'POST',
      credentials: 'include',
      body,
    });
    if (!res.ok) {
      let code = 'upload_failed';
      let message = `Upload failed (${res.status}).`;
      try {
        const parsed = (await res.json()) as Partial<ApiError>;
        if (parsed.error) code = parsed.error;
        if (parsed.message) message = parsed.message;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      throw new ApiRequestError(res.status, code, message);
    }
    return (await res.json()) as BannerCreativeView;
  },
};

/* ------------------------------------------------------------------ *
 * Public Home & Discovery (US-102.4)
 * ------------------------------------------------------------------ */

export interface PublicClip {
  id: string;
  mediaType: 'image' | 'video';
  /** Opaque, id-keyed route. Never a storage key or path. */
  url: string;
  characterId: string;
  characterName: string;
}

export interface PublicCharacterCard {
  id: string;
  /** Stable slug — the local clip manifest keys on it. */
  name: string;
  displayName: string;
  shortBio: string;
  /** Legacy display locator on the character. Never a storage key or path. */
  profileImage: string | null;
  /** Real App Category membership; the card chips render these. */
  categories: Array<{ slug: string; name: string }>;
  clip: PublicClip | null;
}

/**
 * A Play with Me card — Home's own shape, narrower than `PublicCharacterCard`.
 *
 * `name`, `shortBio` and `profileImage` are absent: the rail renders a video
 * tile, a display name, an age and up to two category chips, and never read
 * them. `/api/browse/characters` still serves the wider shape unchanged.
 *
 * `apparentAgeBand` is the ONE Visual Identity value a card needs. It used to
 * arrive from a per-card `/api/characters/:id/visual-identity` request — six
 * requests for a six-card rail, of which everything but this one string was
 * discarded. The band now travels with the card and `adultAgeFromBand` turns it
 * into exactly the label it always did. `null` means no active identity or no
 * band recorded, which is precisely the state a failed or empty fetch produced,
 * and it lands on the same default age.
 */
export interface PublicPlayWithMeCard {
  id: string;
  displayName: string;
  /** Raw apparent-age band, or null. The card derives its age label from it. */
  apparentAgeBand: string | null;
  /** Real App Category membership; the card chips render these. */
  categories: Array<{ slug: string; name: string }>;
  clip: PublicClip | null;
}

/** One lobby category pill — an enabled App Category, in the operator's order. */
export interface PublicCategoryPill {
  id: string;
  slug: string;
  name: string;
}

export interface PublicHomeBanner {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  creativeUrl: string | null;
  creativeMediaType: 'image' | 'video' | null;
  destination: {
    kind: string;
    categoryId: string | null;
    characterId: string | null;
    assetId: string | null;
    url: string | null;
  };
}

export interface PublicCategoryRail {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  clips: PublicClip[];
}

export interface PublicHome {
  banners: Record<HomeBannerSlot, PublicHomeBanner[]>;
  hero: PublicClip[];
  playWithMe: PublicPlayWithMeCard[];
  categories: PublicCategoryRail[];
  /**
   * The category pills, in the operator's CMS order — the same list
   * `/api/categories` serves, built from the rows Home composition already
   * reads. Home used to fetch it in a second request; that round trip is gone.
   */
  categoryPills: PublicCategoryPill[];
  /**
   * The first page of the results grid under the search box — the same clips,
   * in the same order, that an unfiltered `/api/browse/clips` returned, bounded
   * instead of unbounded. The grid renders its familiar content on arrival
   * without the browser downloading the whole public corpus to do it; searching
   * or picking a pill goes back to `/api/browse/clips` for the real answer.
   */
  browseClips: PublicClip[];
}

export interface PublicDiscoveryCategory {
  id: string;
  slug: string;
  name: string;
}

export const homeApi = {
  get: () => request<PublicHome>('/api/home'),
  /**
   * The Play with me population, on its own.
   *
   * SAME SHAPE, SAME RULE, SAME SERVER FUNCTION as `home.playWithMe`. Swipe
   * reads this; Home reads the copy embedded in `/api/home`. Neither is a
   * fallback for the other and there is no third source — `charactersApi.list()`
   * is NOT a population for these surfaces, because it returns every active
   * character whether or not she has published anything, which is exactly how
   * the deck used to fill up with characters the rail had already dropped.
   *
   * Every card here is eligible by construction: the server drops a character
   * with no publicly reachable video rather than returning her with a null clip.
   */
  playWithMe: () => request<{ characters: PublicPlayWithMeCard[] }>('/api/play-with-me'),
  /** The lobby's category pills — App Categories, the one editorial system. */
  categories: () => request<{ categories: PublicCategoryPill[] }>('/api/categories'),
  /**
   * The character grid. Omitting `category` is the unfiltered "All" state, and
   * is why search works before any category has been configured.
   */
  browse: (params: { category?: string | null; q?: string | null } = {}) => {
    const search = new URLSearchParams();
    if (params.category) search.set('category', params.category);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<{ characters: PublicCharacterCard[] }>(
      `/api/browse/characters${qs ? `?${qs}` : ''}`,
    );
  },
  /**
   * The SEARCH GRID: real CMS content assets, never characters.
   *
   * Each item carries its own asset id and an opaque `/api/media/assets/:id/file`
   * url. There is no fallback shape — a character with nothing published simply
   * contributes no results, and an empty array renders the empty state.
   */
  browseClips: (params: { category?: string | null; q?: string | null } = {}) => {
    const search = new URLSearchParams();
    if (params.category) search.set('category', params.category);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<{ clips: PublicClip[] }>(`/api/browse/clips${qs ? `?${qs}` : ''}`);
  },
};

/**
 * Favourites — the user's saved characters. AUTHENTICATED, always.
 *
 * `credentials: 'include'` is already the default for every call through
 * `request`, so the HttpOnly session cookie carries the identity and no user id
 * is ever sent from the browser. A signed-out caller gets 401 from all three.
 *
 * THE SERVER IS THE SOURCE OF TRUTH. Nothing in this feature is written to
 * localStorage; the browser holds only what it read back from here, which is
 * why a favourite survives a refresh, a new session and another device.
 */
export interface FavouritesResponse {
  /**
   * The gallery cards, composed exactly as Play with me composes them. `clip`
   * is null for a saved character with no currently publishable video — the
   * page renders no tile for her rather than substituting an image.
   */
  favourites: PublicPlayWithMeCard[];
  /**
   * The raw persisted relationship, unfiltered by eligibility. This is what the
   * heart reflects: a character can be saved while temporarily unrenderable,
   * and her heart must stay filled through that.
   */
  characterIds: string[];
}

export const favouritesApi = {
  list: () => request<FavouritesResponse>('/api/favourites'),
  /** Save. Idempotent — repeating it leaves her favourited, never toggles. */
  add: (characterId: string) =>
    request<{ favourited: boolean }>(`/api/favourites/${encodeURIComponent(characterId)}`, {
      method: 'PUT',
    }),
  /** Remove. The filled heart is the only caller. */
  remove: (characterId: string) =>
    request<{ favourited: boolean }>(`/api/favourites/${encodeURIComponent(characterId)}`, {
      method: 'DELETE',
    }),
};

export const discoveryApi = {
  categories: () => request<{ categories: PublicDiscoveryCategory[] }>('/api/discovery/categories'),
  clips: (params: { category?: string | null; q?: string | null; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params.category) search.set('category', params.category);
    if (params.q) search.set('q', params.q);
    if (params.limit != null) search.set('limit', String(params.limit));
    if (params.offset != null) search.set('offset', String(params.offset));
    const qs = search.toString();
    return request<{ clips: PublicClip[]; total: number; maxLimit: number }>(
      `/api/discovery/clips${qs ? `?${qs}` : ''}`,
    );
  },
};

/* ------------------------------------------------------------------ *
 * Admin Home composition & Discovery management (US-102.4)
 * ------------------------------------------------------------------ */

export interface HomeCategoryView {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  enabled: boolean;
  homePublished: boolean;
  homePosition: number;
  publishableAssetCount: number;
  assetCount: number;
  wouldRenderEmpty: boolean;
}

export interface HeroClipAdminView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  status: string;
  publishable: boolean;
  position: number;
  previewUrl: string | null;
}

export interface HeroCandidateView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  previewUrl: string | null;
  approvedAt: string | null;
  inHero: boolean;
}

export const adminHomeApi = {
  overview: () =>
    request<{
      categories: HomeCategoryView[];
      hero: HeroClipAdminView[];
      /**
       * What the public Hero is borrowing because nothing is assigned. Always
       * empty once `hero` has anything in it — a configured Hero is never
       * topped up. Never stored, never an assignment.
       */
      heroFallback: PublicClip[];
    }>('/admin/home'),
  preview: () =>
    request<{ generatedAt: string; newVisitor: PublicHome; returning: PublicHome }>(
      '/admin/home/preview',
    ),
  setPublished: (categoryId: string, homePublished: boolean) =>
    request<HomeCategoryView>(`/admin/home/categories/${encodeURIComponent(categoryId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ homePublished }),
    }),
  orderCategories: (orderedIds: string[]) =>
    request<{ categories: HomeCategoryView[] }>('/admin/home/categories/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
  heroCandidates: () =>
    request<{ candidates: HeroCandidateView[] }>('/admin/home/hero/candidates'),
  addHero: (assetIds: string[]) =>
    request<{ outcomes: Array<{ assetId: string; added: boolean; reason?: string }>; clips: HeroClipAdminView[] }>(
      '/admin/home/hero',
      { method: 'POST', body: JSON.stringify({ assetIds }) },
    ),
  removeHero: (assetId: string) =>
    request<{ removed: true; assetKept: true; clips: HeroClipAdminView[] }>(
      `/admin/home/hero/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),
  orderHero: (orderedIds: string[]) =>
    request<{ clips: HeroClipAdminView[] }>('/admin/home/hero/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
};

export interface KeywordView {
  id: string;
  key: string;
  label: string;
  assetCount: number;
}

export interface DiscoveryCategoryView {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  position: number;
  keywords: KeywordView[];
  matchCount: number;
}

export interface TaggableAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  previewUrl: string | null;
  keywords: KeywordView[];
}

export const adminDiscoveryApi = {
  categories: () => request<{ categories: DiscoveryCategoryView[] }>('/admin/discovery/categories'),
  keywords: () => request<{ keywords: KeywordView[] }>('/admin/discovery/keywords'),
  create: (payload: { name: string; keywords?: string[] }) =>
    request<DiscoveryCategoryView>('/admin/discovery/categories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  update: (id: string, changes: { name?: string; enabled?: boolean }) =>
    request<DiscoveryCategoryView>(`/admin/discovery/categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),
  setKeywords: (id: string, keywords: string[]) =>
    request<DiscoveryCategoryView>(
      `/admin/discovery/categories/${encodeURIComponent(id)}/keywords`,
      { method: 'PUT', body: JSON.stringify({ keywords }) },
    ),
  remove: (id: string) =>
    request<{ deleted: boolean; contentRemoved: number; keywordsKept: number }>(
      `/admin/discovery/categories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  order: (orderedIds: string[]) =>
    request<{ categories: DiscoveryCategoryView[] }>('/admin/discovery/categories/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
  content: () => request<{ assets: TaggableAssetView[] }>('/admin/discovery/content'),
  /**
   * One asset's keywords. The endpoint already existed and is the same one the
   * Discovery screen writes through — this is the missing READ half, so a
   * keyword editor can show what an item currently carries without inventing a
   * second source of truth.
   */
  assetKeywords: (assetId: string) =>
    request<{ keywords: KeywordView[] }>(
      `/admin/discovery/content/${encodeURIComponent(assetId)}/keywords`,
    ),
  setAssetKeywords: (assetId: string, keywords: string[]) =>
    request<{ keywords: KeywordView[] }>(
      `/admin/discovery/content/${encodeURIComponent(assetId)}/keywords`,
      { method: 'PUT', body: JSON.stringify({ keywords }) },
    ),
};

export const contentReviewApi = {
  summary: () =>
    request<{ characters: CharacterReviewSummary[] }>('/admin/content/review/summary'),
  /** The whole board in one request: rail, configuration, inbox count, slots. */
  workspace: (characterId?: string) =>
    request<ReviewWorkspaceView>(
      `/admin/content/review/workspace${characterId ? `?characterId=${encodeURIComponent(characterId)}` : ''}`,
    ),
  /** Files an item under a category, or clears it back to triage with null. */
  setRequirement: (assetId: string, requirementKey: string | null) =>
    request<ReviewAssetView>(`/admin/content/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ requirementKey }),
    }),
  inbox: () => request<{ items: InboxItemView[] }>('/admin/content/inbox'),
  /** Upload with NO character chosen. */
  uploadToInbox: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postMultipart<InboxItemView>('/admin/content/inbox', form, 'Upload failed');
  },
  /** Upload straight to a character (and optionally a category). Enters Review. */
  uploadForCharacter: (file: File, characterId: string, requirementKey?: string) => {
    const form = new FormData();
    form.append('characterId', characterId);
    if (requirementKey) form.append('requirementKey', requirementKey);
    form.append('file', file);
    return postMultipart<ReviewAssetView>('/admin/content/uploads', form, 'Upload failed');
  },
  assignInboxItem: (inboxId: string, body: { characterId: string; requirementKey?: string | null }) =>
    request<{ item: InboxItemView; asset: ReviewAssetView }>(
      `/admin/content/inbox/${encodeURIComponent(inboxId)}/assign`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discardInboxItem: (inboxId: string) =>
    request<InboxItemView>(`/admin/content/inbox/${encodeURIComponent(inboxId)}/discard`, {
      method: 'POST',
    }),
  queue: (params: { characterId?: string; mediaType?: 'image' | 'video' } = {}) => {
    const q = new URLSearchParams();
    if (params.characterId) q.set('characterId', params.characterId);
    if (params.mediaType) q.set('mediaType', params.mediaType);
    const suffix = q.toString() ? `?${q}` : '';
    return request<{ assets: ReviewAssetView[] }>(`/admin/content/review${suffix}`);
  },
  approve: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/approve`, { method: 'POST' }),
  reject: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/reject`, { method: 'POST' }),
  /**
   * Release to / withdraw from the character's Posts tab.
   *
   * Deliberately NOT part of approve: approving is a moderation verdict that
   * exposes nothing, and this is the editorial decision to make a clip public.
   */
  publish: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/publish`, { method: 'POST' }),
  unpublish: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/unpublish`, { method: 'POST' }),
};

/* ------------------------------------------------------------------ *
 * US-101 — character, visual identity and primary reference management
 * ------------------------------------------------------------------ */

export interface AdminCharacterView {
  id: string;
  name: string;
  displayName: string;
  profileImage: string | null;
  shortBio: string;
  personality: string;
  interests: string[];
  conversationStyle: string;
  systemPrompt: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  /** False while any descriptive field is still blank (quick-created draft). */
  profileComplete: boolean;
  /** The still-blank fields, named, so the UI can be specific rather than vague. */
  missingProfileFields: string[];
}

export interface AdminCharacterListItem extends AdminCharacterView {
  activeIdentityVersion: number | null;
  identityVersionCount: number;
  primaryReferenceCount: number;
}

export interface VisualIdentityView {
  id: string;
  characterId: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  label: string | null;
  visualDna: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryReferenceView {
  assetId: string;
  characterId: string;
  visualIdentityId: string;
  kind: 'reference' | 'generated';
  status: string;
  isPrimary: boolean;
  position: number | null;
  contentRating: 'sfw' | 'explicit';
  mediaType: 'image' | 'video';
  fileUrl: string | null;
  createdAt: string;
}

export interface AdminCharacterDetail {
  character: AdminCharacterView;
  identities: VisualIdentityView[];
  activeIdentity: VisualIdentityView | null;
  primaryReferences: PrimaryReferenceView[];
}

/**
 * Phase 2 — avatar-derived persona. Structured identity data, internal like
 * `systemPrompt`: rendered into WHO SHE IS / HER VOICE server-side, never
 * shown to end users. Every field is optional.
 */
export interface CharacterPersonaFields {
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
  sourceSummary?: string;
}

export interface CharacterPersonaView {
  persona: CharacterPersonaFields;
  /** Which fields an admin has explicitly set by hand — regeneration never overwrites these. */
  editedFields: string[];
  /** The canonical reference image the current generated content came from, if any. */
  sourceAssetId: string | null;
  /** When persona generation last ran successfully, or null if it never has. */
  generatedAt: string | null;
  /**
   * The bio/personality/interests the PHOTO implies — returned by a
   * regeneration and NOT saved. The operator accepts it (which applies it
   * through the ordinary character PATCH) or ignores it. Null when the model
   * offered nothing, or when what it offered read as an instruction rather
   * than a description and was therefore discarded server-side.
   */
  proposedProfile?: {
    shortBio?: string;
    personality?: string;
    interests?: string[];
  } | null;
}

/** Fields an operator may set. Exactly the columns the schema already has. */
export interface CharacterDraft {
  name: string;
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests: string[];
  status?: 'active' | 'inactive';
}

/** What Autofill proposes. A DRAFT — nothing is saved until the operator says so. */
export interface CharacterProfileDraft {
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests: string[];
}

export interface QuickCreatedCharacter {
  character: AdminCharacterView;
  /** Null when no photo was supplied — the first upload provisions v1. */
  identity: VisualIdentityView | null;
  primaryReference: PrimaryReferenceView | null;
}

/**
 * Multipart POST. Separate from `request` because the browser must set
 * Content-Type itself (it alone knows the boundary), but the error handling is
 * identical, so it is shared rather than copied a third time.
 */
async function postMultipart<T>(path: string, form: FormData, failure: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `${failure} (${res.status}).`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/** One item on a character's content shelf. */
export interface CharacterContentAsset {
  assetId: string;
  characterId: string;
  kind: string;
  status: 'generated' | 'under_review' | 'approved' | 'rejected';
  mediaType: 'image' | 'video';
  contentRating: 'sfw' | 'explicit';
  requirementKey: string | null;
  isPrimary: boolean;
  position: number | null;
  /** Opaque id-keyed admin locator. Never a storage key or path. */
  previewUrl: string | null;
  placement: {
    categories: Array<{ id: string; slug: string; name: string; position: number }>;
    heroPosition: number | null;
  };
  createdAt: string;
  approvedAt: string | null;
  /**
   * When this clip was RELEASED to the character's public Posts tab, or null.
   * Separate from `approvedAt`: approving is moderation and shows nothing,
   * releasing is what puts it on her page.
   */
  publishedAt: string | null;
}

export const adminCharactersApi = {
  list: () => request<AdminCharacterListItem[]>('/admin/characters'),
  /**
   * A NAME is enough to create a character. Supply an image too and the server
   * also creates visual identity v1, activates it and files the image as her
   * primary reference; omit it and she simply exists, with her first identity
   * provisioned by her first upload. The persona is filled in afterwards, by
   * hand or by Autofill.
   */
  quickCreate: (input: { name: string; displayName?: string; file?: File | null }) => {
    const form = new FormData();
    form.append('name', input.name);
    if (input.displayName) form.append('displayName', input.displayName);
    if (input.file) form.append('file', input.file);
    return postMultipart<QuickCreatedCharacter>(
      '/admin/characters/quick',
      form,
      "Couldn't create the character",
    );
  },
  /**
   * Everything this character has, on her own page: approved, pending and
   * rejected, each with an opaque preview locator, its category membership and
   * its Hero position. Saves a trip to Review just to find out what exists.
   */
  content: (characterId: string) =>
    request<{ assets: CharacterContentAsset[] }>(
      `/admin/characters/${encodeURIComponent(characterId)}/content`,
    ),
  /** What this character still needs, derived from the configuration. */
  requirements: (characterId: string) =>
    request<{
      totals: { required: number; approved: number; pending: number; missing: number; complete: boolean };
      requirements: RequirementEntryView[];
      triageCount: number;
    }>(`/admin/characters/${encodeURIComponent(characterId)}/requirements`),
  /** Proposes a persona. Returns a draft only — call `update` to save it. */
  autofill: (characterId: string) =>
    request<{ draft: CharacterProfileDraft }>(
      `/admin/characters/${encodeURIComponent(characterId)}/autofill`,
      { method: 'POST' },
    ),
  get: (id: string) => request<AdminCharacterDetail>(`/admin/characters/${encodeURIComponent(id)}`),
  /**
   * Creates a character. Only `name` is required — the server defaults the rest
   * and the persona is written (or Autofilled) afterwards. The full draft shape
   * stays available for callers that have one.
   */
  create: (draft: Partial<CharacterDraft> & { name: string }) =>
    request<AdminCharacterView>('/admin/characters', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (id: string, patch: Partial<CharacterDraft>) =>
    request<AdminCharacterView>(`/admin/characters/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  listIdentities: (characterId: string) =>
    request<VisualIdentityView[]>(`/admin/characters/${encodeURIComponent(characterId)}/identities`),
  createIdentity: (
    characterId: string,
    body: { visualDna?: Record<string, unknown>; label?: string; fromIdentityId?: string },
  ) =>
    request<VisualIdentityView>(
      `/admin/characters/${encodeURIComponent(characterId)}/identities`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  activateIdentity: (identityId: string) =>
    request<VisualIdentityView>(`/admin/identities/${encodeURIComponent(identityId)}/activate`, {
      method: 'POST',
    }),
  listReferences: (identityId: string) =>
    request<PrimaryReferenceView[]>(
      `/admin/identities/${encodeURIComponent(identityId)}/references`,
    ),
  /** Multipart, so the browser must set the boundary — see postMultipart. */
  uploadReference: (identityId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postMultipart<PrimaryReferenceView>(
      `/admin/identities/${encodeURIComponent(identityId)}/references`,
      form,
      'Upload failed',
    );
  },
  removePrimary: (assetId: string) =>
    request<PrimaryReferenceView>(`/admin/references/${encodeURIComponent(assetId)}/primary`, {
      method: 'DELETE',
    }),
  makePrimary: (assetId: string) =>
    request<PrimaryReferenceView>(`/admin/references/${encodeURIComponent(assetId)}/primary`, {
      method: 'POST',
    }),
  /* ---------------- Phase 2: avatar-derived persona ---------------- */
  getPersona: (characterId: string) =>
    request<CharacterPersonaView>(`/admin/characters/${encodeURIComponent(characterId)}/persona`),
  /** Partial. Every key sent is validated, merged in, and protected from a later regeneration. */
  savePersona: (characterId: string, edits: Partial<CharacterPersonaFields>) =>
    request<CharacterPersonaView>(
      `/admin/characters/${encodeURIComponent(characterId)}/persona`,
      { method: 'PATCH', body: JSON.stringify(edits) },
    ),
  /**
   * Re-analyses the character's primary reference image. Writes immediately
   * (unlike Autofill) — an admin-edited field is protected structurally, not
   * by a review step, so there is nothing to discard on a bad regeneration.
   */
  regeneratePersona: (characterId: string) =>
    request<CharacterPersonaView>(
      `/admin/characters/${encodeURIComponent(characterId)}/persona/regenerate`,
      { method: 'POST' },
    ),
};

/* ------------------------------------------------------------------ *
 * Admin -> Generation: prompt files -> xAI -> Google Drive
 *
 * NOTHING IN THESE TYPES IS A SECRET. The browser learns whether the
 * providers are live and what a batch cost, never a key, a client secret, a
 * refresh token or a server filesystem path. `driveFolderId` is the operator's
 * own folder, which they configured.
 * ------------------------------------------------------------------ */

export type PromptOutputStatus =
  | 'pending'
  | 'generated'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'drive_upload_failed';

export type PromptJobStatus =
  | 'queued'
  | 'generating'
  | 'uploading'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type PromptBatchStatus = 'draft' | 'running' | 'paused' | 'completed';

export interface PromptGenerationParams {
  aspectRatio: string;
  resolution: '1k' | '2k';
  quality: 'low' | 'medium';
}

export interface PromptOutputView {
  id: string;
  ordinal: number;
  status: PromptOutputStatus;
  outputFilename: string;
  driveFileId: string | null;
  driveWebViewLink: string | null;
  attempts: number;
  error: { kind: string; message: string } | null;
  generatedAt: string | null;
  uploadedAt: string | null;
}

export interface PromptJobView {
  id: string;
  ordinal: number;
  originalFilename: string;
  status: PromptJobStatus;
  requestedOutputs: number;
  succeededCount: number;
  failedCount: number;
  attempts: number;
  error: { kind: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  outputs: PromptOutputView[];
}

export interface PromptCostEstimate {
  prompts: number;
  outputsPerPrompt: number;
  images: number;
  pricePerImageUsd: number;
  totalUsd: number;
}

export interface PromptBatchView {
  id: string;
  name: string;
  status: PromptBatchStatus;
  model: string;
  params: PromptGenerationParams;
  outputsPerPrompt: number;
  driveFolderId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totals: { prompts: number; outputs: number; completed: number; failed: number };
  estimate: PromptCostEstimate;
  jobs?: PromptJobView[];
}

export interface PromptGenerationSettings {
  model: string;
  outputsPerPrompt: number;
  params: PromptGenerationParams;
  aspectRatios: string[];
  pricePerImageUsd: number;
  xaiLive: boolean;
  driveLive: boolean;
  driveFolderId: string | null;
  /**
   * Where the destination came from. `app_created` is the folder this server
   * made for itself, and the only kind the `drive.file` scope can write to;
   * `configured` is a GOOGLE_DRIVE_FOLDER_ID override, which works only if it
   * happens to name a folder this app created earlier.
   */
  driveFolderSource: 'app_created' | 'configured' | 'none';
  driveFolderName: string | null;
  /** Never a token — an account name, a timestamp and an error KIND. */
  driveConnection: DriveConnectionStatus;
  qualityNote: string;
}

export interface DriveConnectionStatus {
  connected: boolean;
  /** 'oauth' = connected from this screen; 'env' = the legacy variable. */
  source: 'oauth' | 'env' | 'none';
  googleAccountEmail: string | null;
  scope: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorKind: string | null;
  lastErrorAt: string | null;
}

export interface PromptIngestOutcome {
  filename: string;
  accepted: boolean;
  reason?: string;
  message?: string;
  jobId?: string;
}

export const promptGenerationApi = {
  settings: () =>
    request<PromptGenerationSettings>('/admin/prompt-generation/settings'),
  listBatches: () =>
    request<{ batches: PromptBatchView[] }>('/admin/prompt-generation/batches'),
  createBatch: (name: string) =>
    request<{ batch: PromptBatchView }>('/admin/prompt-generation/batches', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  batch: (batchId: string) =>
    request<{ batch: PromptBatchView }>(
      `/admin/prompt-generation/batches/${encodeURIComponent(batchId)}`,
    ),
  /** Multipart, so the browser must set the boundary — see postMultipart. */
  uploadFiles: (batchId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return postMultipart<{
      outcomes: PromptIngestOutcome[];
      added: number;
      refused: number;
      batch: PromptBatchView;
    }>(
      `/admin/prompt-generation/batches/${encodeURIComponent(batchId)}/files`,
      form,
      'Upload failed',
    );
  },
  start: (batchId: string) =>
    request<{ started: boolean; reason: string | null; batch: PromptBatchView }>(
      `/admin/prompt-generation/batches/${encodeURIComponent(batchId)}/start`,
      { method: 'POST' },
    ),
  pause: (batchId: string) =>
    request<{ paused: boolean; batch: PromptBatchView }>(
      `/admin/prompt-generation/batches/${encodeURIComponent(batchId)}/pause`,
      { method: 'POST' },
    ),
  /**
   * Starts the Google consent flow. The server returns a URL; the browser
   * navigates to it. NO CREDENTIAL PASSES THROUGH HERE — the client secret
   * never leaves the API, and the code that comes back is exchanged there.
   */
  connectDrive: () =>
    request<{ authorizationUrl: string }>('/admin/prompt-generation/drive/connect', {
      method: 'POST',
    }),
  disconnectDrive: () =>
    request<{ disconnected: boolean }>('/admin/prompt-generation/drive/disconnect', {
      method: 'POST',
    }),
  retryFailed: (batchId: string) =>
    request<{ retried: number; batch: PromptBatchView }>(
      `/admin/prompt-generation/batches/${encodeURIComponent(batchId)}/retry-failed`,
      { method: 'POST' },
    ),
  retryJob: (jobId: string) =>
    request<{ retried: boolean }>(
      `/admin/prompt-generation/jobs/${encodeURIComponent(jobId)}/retry`,
      { method: 'POST' },
    ),
  retryOutput: (outputId: string) =>
    request<{ retried: boolean }>(
      `/admin/prompt-generation/outputs/${encodeURIComponent(outputId)}/retry`,
      { method: 'POST' },
    ),
};
