import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/client.js';
import { buildApp, type BuildAppOptions } from '../app.js';
import type { Env } from '../env.js';

/**
 * Test harness: builds the app against an ISOLATED local test database.
 *
 * Safety: refuses to run against anything that is not an explicitly named
 * *_test database, so these destructive tests can never touch the Railway
 * production database.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://over18:over18_local_dev@127.0.0.1:5432/over18_test';

if (!/_test(\?|$)/.test(new URL(TEST_DATABASE_URL).pathname)) {
  throw new Error('Refusing to run tests: TEST_DATABASE_URL must point at a *_test database.');
}

export const testEnv: Env = {
  databaseUrl: TEST_DATABASE_URL,
  port: 0,
  host: '127.0.0.1',
  corsOrigin: 'http://localhost:5173',
  cookieSecure: false,
  cookieSameSite: 'lax',
  sessionTtlDays: 30,
  isProduction: false,
  llm: null, // tests always inject providers explicitly — no real endpoint
  personaVision: null, // tests always inject a PersonaGenerator explicitly
  memory: { maxInjected: 10, maxInjectedChars: 2_000, maxStored: 100 },
  // Matches production's default: OFF. Tests that exercise Character Media
  // Messages opt in explicitly via createTestContext({ chatMediaEnabled: true }),
  // so every other suite proves the feature is genuinely inert when disabled.
  chatMedia: { enabled: false },
  media: {
    // US-36: media tests inject the mock provider; these paths are a writable
    // scratch area, and the internal token is fixed so tests can present it.
    storageDir: `${tmpdir()}/over18-test-media`,
    publicBaseUrl: null,
    internalToken: 'test-internal-token',
    ledgerPath: `${tmpdir()}/over18-test-media/cost-ledger.json`,
    // Matches production's default: OFF. Suites that exercise optimised
    // derivatives opt in explicitly, so every other suite proves the switch is
    // genuinely inert and originals are what get served.
    optimisedEnabled: false,
    atlas: {
      baseUrl: 'https://example.invalid/api/v1',
      imageModel: 'test-image-model',
      videoModel: 'test-video-model',
      live: false,
    },
    // US-87: default off in tests (providers injected explicitly).
    runpod: {
      endpointId: null,
      live: false,
      preferForImages: true,
    },
  },
  // Matches production's default: NOT live. The prompt-workspace suite injects
  // stub providers, so every other suite proves no test can reach xAI or
  // Google even by accident.
  promptGeneration: {
    xai: {
      baseUrl: 'https://example.invalid/v1',
      model: 'test-image-model',
      apiKey: null,
      timeoutMs: 5_000,
      maxAttempts: 1,
      // Effectively unthrottled: pacing is asserted directly against the
      // limiter, and making every other test wait on a token bucket would only
      // make the suite slow.
      requestsPerSecond: 1000,
      maxConcurrent: 2,
      live: false,
    },
    drive: {
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      folderId: 'test-drive-folder',
      timeoutMs: 5_000,
      live: false,
      tokenUrl: null,
      uploadUrl: null,
      filesUrl: null,
      redirectUri: 'http://127.0.0.1:3001/admin/prompt-generation/drive/callback',
      // A fixed 32-byte key, so encryption is exercised in every suite rather
      // than skipped for want of configuration.
      tokenEncryptionKey: 'Y2FmZWJhYmVkZWFkYmVlZmNhZmViYWJlZGVhZGJlZWY=',
      userinfoUrl: null,
      authUrl: null,
    },
    spoolDir: `${tmpdir()}/over18-test-media/prompt-generation`,
  },
};

export function migrateTestDb(): void {
  execSync('npx drizzle-kit migrate', {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}

export interface TestContext {
  app: FastifyInstance;
  db: ReturnType<typeof createDb>['db'];
  pool: ReturnType<typeof createDb>['pool'];
}

export async function createTestContext(
  options: BuildAppOptions & { chatMediaEnabled?: boolean; optimisedMediaEnabled?: boolean } = {},
): Promise<TestContext> {
  const { chatMediaEnabled, optimisedMediaEnabled, ...appOptions } = options;
  const { db, pool } = createDb(TEST_DATABASE_URL);
  let env: Env = testEnv;
  if (chatMediaEnabled) env = { ...env, chatMedia: { enabled: true } };
  if (optimisedMediaEnabled) {
    env = { ...env, media: { ...env.media, optimisedEnabled: true } };
  }
  const app = await buildApp(env, db, appOptions);
  return { app, db, pool };
}

export async function truncateAll(ctx: TestContext): Promise<void> {
  await ctx.pool.query(
    'TRUNCATE TABLE prompt_drive_connections, prompt_drive_oauth_states, prompt_drive_folders, prompt_job_outputs, prompt_jobs, prompt_batches, discovery_category_keywords, discovery_categories, asset_keywords, content_keywords, home_hero_clips, home_recent_characters, home_banners, banner_creatives, app_category_assets, app_categories, content_inbox, character_visual_assets, character_visual_identities, memories, favourites, messages, conversations, sessions, users, characters CASCADE',
  );
}

/**
 * Restores the DEFAULT content requirements by re-running the seed statement
 * from the migration itself.
 *
 * Deliberately reads the SQL rather than restating the defaults in TypeScript:
 * the categories and quantities have exactly one definition in this repository,
 * and a test that hard-coded them would quietly let that stop being true.
 */
export async function resetContentRequirements(ctx: TestContext): Promise<void> {
  const migration = new URL(
    '../../drizzle/0012_add_content_requirements_and_inbox.sql',
    import.meta.url,
  );
  const sql = readFileSync(migration, 'utf8');
  const seed = sql.slice(sql.indexOf('INSERT INTO "content_requirements"'));
  await ctx.pool.query('TRUNCATE TABLE content_requirements CASCADE');
  await ctx.pool.query(seed);
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

/** Extracts the session cookie value from a light-my-request response. */
export function extractSessionCookie(res: {
  cookies: Array<{ name: string; value: string }>;
}): { name: string; value: string } | undefined {
  return res.cookies.find((c) => c.name === 'over18_session');
}
