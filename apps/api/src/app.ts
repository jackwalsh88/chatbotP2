import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type { HealthResponse } from '@over18/shared';
import type { Env } from './env.js';
import type { Db } from './db/client.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import characterRoutes from './routes/characters.js';
import conversationRoutes from './routes/conversations.js';
import favouriteRoutes from './routes/favourites.js';
import messageRoutes from './routes/messages.js';
import conversationMediaRoutes from './routes/conversation-media.js';
import internalMediaRoutes from './routes/internal-media.js';
import generationRoutes from './routes/generation.js';
import adminPromptGenerationRoutes from './routes/admin-prompt-generation.js';
import { selectPromptGenerationDeps } from './prompt-generation/select-providers.js';
import type { PromptRunnerDeps } from './prompt-generation/runner.js';
import adminContentRoutes from './routes/admin-content.js';
import adminCharacterRoutes from './routes/admin-characters.js';
import adminSettingsRoutes from './routes/admin-settings.js';
import adminAppCategoryRoutes from './routes/admin-app-categories.js';
import adminHomeBannerRoutes from './routes/admin-home-banners.js';
import adminHomeRoutes from './routes/admin-home.js';
import adminDiscoveryRoutes from './routes/admin-discovery.js';
import publicHomeRoutes from './routes/public-home.js';
import { deterministicReplyProvider, type ReplyProvider } from './services/character-reply.js';
import { noopMemoryExtractor, type MemoryExtractor } from './services/memory-extractor.js';
import {
  createDeterministicMediaSelector,
  type MediaSelector,
} from './services/message-media-service.js';
import {
  unconfiguredProfileAuthor,
  type ProfileAuthor,
} from './services/character-profile-service.js';
import {
  unconfiguredPersonaGenerator,
  type PersonaGenerator,
} from './services/character-persona-generator.js';
import type { MediaProviders } from './media-pipeline/types.js';

export interface BuildAppOptions {
  /** Reply provider for chat messages. Defaults to the deterministic fallback. */
  replyProvider?: ReplyProvider;
  /**
   * US-12 memory extractor. Defaults to noop so existing tests/behavior are
   * unchanged unless one is injected (server.ts selects from the env).
   */
  memoryExtractor?: MemoryExtractor;
  /**
   * US-36 media providers (image + video). When provided, the internal media
   * endpoints are registered. Tests inject the mock adapter; server.ts injects
   * the env-selected providers.
   */
  mediaProviders?: MediaProviders;
  /**
   * Character Media Messages selector override, for tests. Still gated by
   * env.chatMedia.enabled — injecting one cannot switch the feature on.
   */
  mediaSelector?: MediaSelector;
  /**
   * Character profile Autofill. Defaults to the unconfigured author, which
   * reports Autofill as unavailable rather than inventing a profile — the same
   * "fail clearly, never fake" rule the reply provider follows.
   */
  profileAuthor?: ProfileAuthor;
  /**
   * Avatar-derived persona generation (Phase 2). Defaults to the
   * unconfigured generator, which reports itself unavailable rather than
   * inventing a persona — same "fail clearly, never fake" rule as above.
   */
  personaGenerator?: PersonaGenerator;
  /**
   * Admin -> Generation dependencies (xAI + Google Drive + the spool).
   *
   * Defaults to the env-selected pair, which is a MOCK unless both a confirm
   * flag and a key are present. Tests inject stubs to exercise 429s, Drive
   * failures and restart recovery without a network or a bill.
   */
  promptGeneration?: PromptRunnerDeps;
}

/**
 * Builds and configures the Fastify instance.
 * Kept separate from server.ts so tests can build an app against an
 * isolated database (and an injected fake reply provider) without opening
 * a network port.
 */
export async function buildApp(env: Env, db: Db, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      // Never log request bodies (passwords) or cookie headers (session tokens).
      serializers: {
        req(request) {
          return { method: request.method, url: request.url };
        },
      },
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  });

  await app.register(cors, {
    // Origin-specific (never "*") so credentialed requests are allowed.
    origin: env.corsOrigin,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(authPlugin, { db });

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: 'over18-api',
      timestamp: new Date().toISOString(),
    };
  });

  // US-106 admin content review — reads existing assets, so it does not
  // depend on media providers being configured.
  await app.register(adminContentRoutes, {
    optimisedMedia: env.media.optimisedEnabled,
    db,
    // Manual Library upload writes under the same MEDIA_STORAGE_DIR the media
    // pipeline uses; it needs no provider, so it is always available.
    uploadStorage: {
      storageDir: env.media.storageDir,
      servePathPrefix: '/admin/content/uploads',
    },
  });
  // US-101 character / visual identity / primary reference management.
  // Registered alongside the content routes but as its OWN plugin: identity
  // management and content review are deliberately separate surfaces.
  await app.register(adminCharacterRoutes, {
    db,
    uploadStorage: {
      storageDir: env.media.storageDir,
      servePathPrefix: '/admin/content/uploads',
    },
    profileAuthor: options.profileAuthor ?? unconfiguredProfileAuthor,
    personaGenerator: options.personaGenerator ?? unconfiguredPersonaGenerator,
  });
  // Admin → Settings. Content requirements are configuration, so they get their
  // own plugin rather than living inside the content-review surface that reads
  // them — the definition and the work it drives stay separable.
  await app.register(adminSettingsRoutes, { db });
  // US-102.1 Admin → Categories & Publishing. The App CMS surface: how already
  // approved content is ORGANISED in the app, as opposed to what must be
  // produced. Its own plugin so merchandising and production configuration
  // cannot drift into one another.
  await app.register(adminAppCategoryRoutes, { db });
  // US-102.3 Admin → Categories & Publishing → Banners. Its own plugin: banner
  // creatives are dedicated CMS assets with their own storage subtree, and
  // nothing here touches Review, content requirements or generation.
  await app.register(adminHomeBannerRoutes, {
    db,
    creativeStorage: { storageDir: env.media.storageDir },
  });
  // US-102.4 Admin → Categories & Publishing → Home and Discovery. Two plugins
  // because they are two systems: Home publishes editorial App Categories,
  // Discovery is a keyword index over all content. Neither can write the
  // other's tables.
  await app.register(adminHomeRoutes, { db, mediaStorageDir: env.media.storageDir });
  await app.register(adminDiscoveryRoutes, { db });
  // US-102.4 the PUBLIC app surface: Home, Discovery and public media. No auth
  // by design, which is why every projection it serves is narrow and every read
  // is approval-gated.
  await app.register(publicHomeRoutes, {
    optimisedMedia: env.media.optimisedEnabled,
    db,
    mediaStorageDir: env.media.storageDir,
    cookie: { secure: env.cookieSecure, sameSite: env.cookieSameSite },
  });
  await app.register(authRoutes, { db, env });
  await app.register(characterRoutes, { db });
  await app.register(conversationRoutes, { db });
  /**
   * Favourites — the user's saved characters.
   *
   * Its OWN plugin, next to conversations rather than inside the public Home
   * surface, because it is the same kind of thing a conversation is: a
   * per-user, session-scoped relationship to a character. `publicHomeRoutes` is
   * deliberately account-free and must stay that way.
   */
  await app.register(favouriteRoutes, { db });
  // Character Media Messages (commit 2). The flag is a STRUCTURAL kill switch:
  // when it is off no selector object exists, so the eligibility query cannot
  // run and media_asset_id can never be written — rather than selecting an
  // asset and then declining to show it.
  const mediaSelector = env.chatMedia.enabled
    ? (options.mediaSelector ?? createDeterministicMediaSelector(env.media.storageDir))
    : null;

  await app.register(messageRoutes, {
    db,
    replyProvider: options.replyProvider ?? deterministicReplyProvider,
    memoryExtractor: options.memoryExtractor ?? noopMemoryExtractor,
    memoryMaxStored: env.memory.maxStored,
    mediaSelector,
  });

  // Character Media Messages (commit 1) — serves the media attached to a
  // message. Registered unconditionally: it reads existing rows and files, so
  // like the admin content routes it needs no media provider. Inert until a
  // later commit writes messages.media_asset_id.
  await app.register(conversationMediaRoutes, {
    optimisedMedia: env.media.optimisedEnabled,
    db,
    storageDir: env.media.storageDir,
  });

  // US-36 internal media endpoints — registered only when providers are
  // injected (server.ts wires the env-selected adapter; tests inject the mock).
  if (options.mediaProviders) {
    await app.register(internalMediaRoutes, {
      db,
      providers: options.mediaProviders,
      storage: { storageDir: env.media.storageDir, publicBaseUrl: env.media.publicBaseUrl },
      ledgerPath: env.media.ledgerPath,
      internalToken: env.media.internalToken,
    });

    // US-103 admin generation API — same providers/ledger/storage, but gated by
    // session auth + admin role rather than the shared internal token.
    await app.register(generationRoutes, {
      db,
      providers: options.mediaProviders,
      storage: { storageDir: env.media.storageDir, publicBaseUrl: env.media.publicBaseUrl },
      ledgerPath: env.media.ledgerPath,
    });
  }

  /**
   * Admin -> Generation (prompt files -> xAI -> Google Drive).
   *
   * Registered unconditionally, because the workspace has to be usable — and
   * testable — before any credential exists: without them the selected
   * providers are mocks. Nothing it registers can reach character content.
   */
  await app.register(adminPromptGenerationRoutes, {
    db,
    runner: options.promptGeneration ?? selectPromptGenerationDeps(env.promptGeneration, db),
    readiness: {
      xaiLive: env.promptGeneration.xai.live,
      driveLive: env.promptGeneration.drive.live,
      googleClientId: env.promptGeneration.drive.clientId,
      googleClientSecret: env.promptGeneration.drive.clientSecret,
      redirectUri: env.promptGeneration.drive.redirectUri,
      tokenEncryptionKey: env.promptGeneration.drive.tokenEncryptionKey,
      envRefreshTokenPresent: Boolean(env.promptGeneration.drive.refreshToken),
      /**
       * The callback redirects the operator back to the PAGE they started
       * from, which lives in the web app. `corsOrigin` is already the web
       * app's origin, so there is one setting rather than two that can drift.
       */
      webBaseUrl: env.corsOrigin.split(',')[0]!.trim().replace(/\/$/, ''),
      tokenUrlOverride: env.promptGeneration.drive.tokenUrl,
      userinfoUrlOverride: env.promptGeneration.drive.userinfoUrl,
      authUrlOverride: env.promptGeneration.drive.authUrl,
    },
  });

  return app;
}
