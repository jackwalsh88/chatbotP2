/**
 * Central, fail-fast environment access.
 *
 * DATABASE_URL is required: the process exits with a clear message when it is
 * missing. Its value is never logged anywhere.
 */

export interface LlmEnv {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  contextMaxMessages: number;
  contextMaxChars: number;
}

/**
 * Vision-capable inference config (Phase 2 avatar-derived persona).
 *
 * NO NEW CONFIG IS REQUIRED to use it: every field defaults to the matching
 * LLM_* value, so if the already-configured chat endpoint happens to be
 * vision-capable, persona generation just works. PERSONA_VISION_* exists
 * purely as an override seam for pointing this ONE feature at a different
 * model/endpoint later without touching chat or Autofill's configuration.
 * Still provider-neutral by construction — nothing here names a vendor.
 */
export interface VisionEnv {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export interface MemoryEnv {
  maxInjected: number;
  maxInjectedChars: number;
  maxStored: number;
}

export interface MediaEnv {
  storageDir: string;
  publicBaseUrl: string | null;
  internalToken: string | null;
  ledgerPath: string;
  /**
   * Whether a verified optimised derivative may be served in place of the
   * original upload. OFF unless MEDIA_OPTIMISED_ENABLED is exactly "true".
   *
   * THIS IS THE ROLLBACK. Setting it back to anything else returns every
   * surface — Home, the Character page, Discover, chat, admin preview — to the
   * original files on the very next request. No file is moved, no row is
   * rewritten and no deploy is needed, because the derivative is an ADDITIONAL
   * file recorded in an ADDITIONAL provenance key: turning this off simply
   * stops anything reading that key.
   *
   * Default OFF, deliberately. A derivative that exists on disk and is
   * recorded on the row is still inert until an operator turns this on, so
   * shipping the machinery and shipping the behaviour are two separate
   * decisions.
   */
  optimisedEnabled: boolean;
  atlas: {
    baseUrl: string;
    imageModel: string;
    videoModel: string;
    live: boolean;
  };
  runpod: {
    endpointId: string | null;
    live: boolean;
    preferForImages: boolean;
  };
}

/**
 * Character Media Messages. OFF unless CHAT_MEDIA_ENABLED is exactly "true".
 *
 * "Off" does not mean "select an asset then hide it" — it means no selector is
 * constructed at all (see app.ts), so the eligibility query never runs and
 * media_asset_id is never written. The kill switch is structural, not cosmetic.
 */
export interface ChatMediaEnv {
  enabled: boolean;
}

/**
 * Admin -> Generation: prompts to xAI, images to one Google Drive folder.
 *
 * BOTH HALVES FOLLOW THE `MEDIA_LIVE_CONFIRM` RULE that has kept this
 * repository from spending money by accident: a paid provider is reached only
 * when a confirm flag AND a key are both present. Absent either, a mock runs
 * and the whole workspace — queue, states, retries, uploads — is exercisable
 * for nothing.
 *
 * NOTHING IN HERE EVER REACHES A BROWSER. The web app receives batch rows and
 * Drive links; never a key, a client secret, a refresh token or a spool path.
 */
export interface PromptGenerationEnv {
  xai: {
    baseUrl: string;
    model: string;
    apiKey: string | null;
    timeoutMs: number;
    maxAttempts: number;
    /** Kept under xAI's published 6 req/s for grok-imagine-image-2.0. */
    requestsPerSecond: number;
    maxConcurrent: number;
    live: boolean;
  };
  drive: {
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    /**
     * OPTIONAL, AND NORMALLY UNSET. A legacy override for pinning a folder
     * this application created earlier — after a database restore, say.
     *
     * It is NOT the way to choose a destination any more, because it cannot
     * be: the scope is `drive.file`, so a folder the operator makes by hand in
     * the Drive web UI is invisible to this application and every upload into
     * it fails with 404 `notFound`. Left unset, the app creates and remembers
     * its own folder, which is the only kind it can address.
     */
    folderId: string | null;
    timeoutMs: number;
    live: boolean;
    /**
     * Endpoint overrides, defaulting to Google.
     *
     * They exist so the REAL client — the same OAuth exchange and the same
     * multipart upload — can be pointed at a local stand-in during end-to-end
     * verification, instead of that path being covered only by an in-memory
     * fake it does not share code with. Unset in production, where they fall
     * back to Google's own URLs.
     */
    tokenUrl: string | null;
    uploadUrl: string | null;
    filesUrl: string | null;
    redirectUri: string | null;
    tokenEncryptionKey: string | null;
    userinfoUrl: string | null;
    authUrl: string | null;
  };
  /** Where generated bytes wait between xAI and Drive. Never served. */
  spoolDir: string;
}

export interface Env {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigin: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  sessionTtlDays: number;
  isProduction: boolean;
  llm: LlmEnv | null;
  personaVision: VisionEnv | null;
  memory: MemoryEnv;
  media: MediaEnv;
  chatMedia: ChatMediaEnv;
  promptGeneration: PromptGenerationEnv;
}

/** True for "true" / "TRUE" / " true " — ignores accidental whitespace. */
function envFlagTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function envNonEmpty(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'FATAL: DATABASE_URL is not set. ' +
        'Provide a PostgreSQL connection string via the DATABASE_URL environment variable ' +
        '(on Railway this is injected automatically; locally, copy apps/api/.env.example to .env).',
    );
    process.exit(1);
  }

  const sameSite = process.env.COOKIE_SAMESITE ?? 'lax';
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    console.error(`FATAL: COOKIE_SAMESITE must be one of lax|strict|none, got "${sameSite}".`);
    process.exit(1);
  }

  let llm: LlmEnv | null = null;
  if (process.env.LLM_BASE_URL) {
    const model = process.env.LLM_MODEL;
    if (!model) {
      console.error('FATAL: LLM_BASE_URL is set but LLM_MODEL is missing.');
      process.exit(1);
    }
    const provider = process.env.LLM_PROVIDER ?? 'openai-compatible';
    if (provider !== 'openai-compatible') {
      console.error(`FATAL: unsupported LLM_PROVIDER "${provider}" (supported: openai-compatible).`);
      process.exit(1);
    }
    llm = {
      provider,
      baseUrl: process.env.LLM_BASE_URL,
      model,
      apiKey: process.env.LLM_API_KEY || undefined,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 512),
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0.8),
      contextMaxMessages: Number(process.env.LLM_CONTEXT_MAX_MESSAGES ?? 40),
      contextMaxChars: Number(process.env.LLM_CONTEXT_MAX_CHARS ?? 16_000),
    };
  }

  // Defaults entirely to the LLM_* config resolved above: PERSONA_VISION_*
  // overrides individual fields only when set. No baseUrl (from either
  // source) means no vision config at all — selectPersonaGenerator reports
  // itself unconfigured rather than guessing.
  const visionBaseUrl = process.env.PERSONA_VISION_BASE_URL || llm?.baseUrl;
  const visionModel = process.env.PERSONA_VISION_MODEL || llm?.model;
  let personaVision: VisionEnv | null = null;
  if (visionBaseUrl && visionModel) {
    personaVision = {
      provider: 'openai-compatible',
      baseUrl: visionBaseUrl,
      model: visionModel,
      apiKey: process.env.PERSONA_VISION_API_KEY || llm?.apiKey,
      timeoutMs: Number(process.env.PERSONA_VISION_TIMEOUT_MS ?? llm?.timeoutMs ?? 45_000),
      maxTokens: Number(process.env.PERSONA_VISION_MAX_TOKENS ?? 700),
      temperature: Number(process.env.PERSONA_VISION_TEMPERATURE ?? 0.4),
    };
  }

  const runpodEndpointId = (process.env.RUNPOD_ENDPOINT_ID ?? '').trim() || null;

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    cookieSecure:
      (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')).trim() ===
      'true',
    cookieSameSite: sameSite,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
    isProduction: process.env.NODE_ENV === 'production',
    llm,
    personaVision,
    memory: {
      maxInjected: Number(process.env.MEMORY_MAX_INJECTED ?? 10),
      maxInjectedChars: Number(process.env.MEMORY_MAX_INJECTED_CHARS ?? 2_000),
      maxStored: Number(process.env.MEMORY_MAX_STORED ?? 100),
    },
    // Default OFF: anything other than exactly "true" leaves chat text-only.
    chatMedia: { enabled: envFlagTrue('CHAT_MEDIA_ENABLED') },
    media: {
      storageDir: process.env.MEDIA_STORAGE_DIR ?? 'var/media',
      publicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || null,
      internalToken: process.env.INTERNAL_MEDIA_TOKEN || null,
      ledgerPath: process.env.MEDIA_LEDGER_PATH ?? 'var/media/cost-ledger.json',
      // Default OFF: anything other than exactly "true" serves originals.
      optimisedEnabled: envFlagTrue('MEDIA_OPTIMISED_ENABLED'),
      atlas: {
        baseUrl: process.env.ATLAS_BASE_URL ?? 'https://api.atlascloud.ai/api/v1',
        imageModel: process.env.ATLAS_IMAGE_MODEL ?? 'black-forest-labs/flux-kontext-dev',
        videoModel: process.env.ATLAS_VIDEO_MODEL ?? 'atlascloud/wan-2.7-spicy/image-to-video',
        live: envFlagTrue('MEDIA_LIVE_CONFIRM') && envNonEmpty('ATLASCLOUD_API_KEY'),
      },
      runpod: {
        endpointId: runpodEndpointId,
        live:
          envFlagTrue('MEDIA_RUNPOD_CONFIRM') &&
          envNonEmpty('RUNPOD_API_KEY') &&
          Boolean(runpodEndpointId),
        preferForImages: (process.env.MEDIA_IMAGE_PROVIDER ?? 'runpod').trim().toLowerCase() !== 'atlas',
      },
    },
    promptGeneration: {
      xai: {
        baseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
        model: process.env.XAI_IMAGE_MODEL ?? 'grok-imagine-image-2.0',
        apiKey: process.env.XAI_API_KEY || null,
        timeoutMs: Number(process.env.XAI_TIMEOUT_MS ?? 120_000),
        maxAttempts: Number(process.env.XAI_MAX_ATTEMPTS ?? 3),
        // xAI documents 6 req/s for this model. We sit under it rather than on
        // it, because the published figure is a ceiling and not a target.
        requestsPerSecond: Number(process.env.XAI_REQUESTS_PER_SECOND ?? 4),
        maxConcurrent: Number(process.env.XAI_MAX_CONCURRENCY ?? 3),
        // Default OFF: without both the confirm flag and a key, a mock runs and
        // no money is spent.
        live: envFlagTrue('XAI_LIVE_CONFIRM') && envNonEmpty('XAI_API_KEY'),
      },
      drive: {
        /**
         * TRIMMED, unlike the first cut of this block. A refresh token or a
         * folder id pasted out of a browser can carry a trailing newline, and
         * an untrimmed folder id travels into a Drive `parents` array where it
         * produces a 404 that looks exactly like a missing folder.
         */
        clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim() || null,
        clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim() || null,
        refreshToken: (process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '').trim() || null,
        folderId: (process.env.GOOGLE_DRIVE_FOLDER_ID ?? '').trim() || null,
        timeoutMs: Number(process.env.GOOGLE_DRIVE_TIMEOUT_MS ?? 60_000),
        /**
         * THE THREE CREDENTIALS, AND NO DESTINATION. A folder id is no longer
         * required — and requiring it was the bug: the only folder this scope
         * can write to is one the app creates for itself, whose id does not
         * exist until it does.
         */
        /**
         * THE CLIENT PAIR ONLY. The refresh token is no longer required here
         * because it is no longer an environment concern: an operator supplies
         * it by connecting Drive, and the env value survives purely as a
         * fallback for a server that has not been connected yet.
         */
        live: envNonEmpty('GOOGLE_OAUTH_CLIENT_ID') && envNonEmpty('GOOGLE_OAUTH_CLIENT_SECRET'),
        tokenUrl: process.env.GOOGLE_DRIVE_TOKEN_URL || null,
        uploadUrl: process.env.GOOGLE_DRIVE_UPLOAD_URL || null,
        filesUrl: process.env.GOOGLE_DRIVE_FILES_URL || null,
        /** Where Google sends the operator back. Must match the Console exactly. */
        redirectUri: (process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim() || null,
        /** AES-256-GCM key, base64, 32 bytes. Without it, connecting is refused. */
        tokenEncryptionKey: (process.env.PROMPT_GENERATION_TOKEN_KEY ?? '').trim() || null,
        userinfoUrl: process.env.GOOGLE_OAUTH_USERINFO_URL || null,
        authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || null,
      },
      spoolDir:
        process.env.PROMPT_GENERATION_SPOOL_DIR ??
        `${process.env.MEDIA_STORAGE_DIR ?? 'var/media'}/prompt-generation`,
    },
  };
}
