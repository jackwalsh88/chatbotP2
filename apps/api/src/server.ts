import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';
import { selectReplyProvider } from './services/llm-reply-provider.js';
import { selectMemoryExtractor } from './services/memory-extractor.js';
import { selectMediaProviders } from './services/media-providers.js';
import { selectProfileAuthor } from './services/character-profile-service.js';
import { selectPersonaGenerator } from './services/character-persona-generator.js';
import { selectPromptGenerationDeps } from './prompt-generation/select-providers.js';
import { recoverInterruptedPromptJobs } from './prompt-generation/runner.js';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);

const app = await buildApp(env, db, {
  replyProvider: selectReplyProvider(env),
  memoryExtractor: selectMemoryExtractor(env),
  mediaProviders: selectMediaProviders(env),
  profileAuthor: selectProfileAuthor(env),
  personaGenerator: selectPersonaGenerator(env),
});

app.log.info(
  env.llm
    ? 'AI replies: LLM inference endpoint configured (openai-compatible)'
    : env.isProduction
      ? 'AI replies: NOT CONFIGURED — production sends will fail with ai_not_configured until LLM_* variables are set'
      : 'AI replies: no LLM configured — using deterministic fallback provider (development only)',
);

const mediaMode =
  env.media.runpod.live && env.media.runpod.preferForImages
    ? 'Media generation: RunPod ComfyUI LIVE for images' +
      (env.media.atlas.live ? ' + Atlas LIVE for video' : ' (video needs Atlas live)')
    : env.media.atlas.live
      ? 'Media generation: Atlas LIVE (paid calls enabled via MEDIA_LIVE_CONFIRM)'
      : 'Media generation: mock provider (set MEDIA_RUNPOD_CONFIRM or MEDIA_LIVE_CONFIRM to go live)';
app.log.info(mediaMode);
// Booleans only — never keys or endpoint ids.
app.log.info(
  `Media flags: atlas.live=${env.media.atlas.live} runpod.live=${env.media.runpod.live} runpod.preferForImages=${env.media.runpod.preferForImages} runpod.endpointSet=${Boolean(env.media.runpod.endpointId)}`,
);

app.log.info(
  env.media.internalToken
    ? 'Media endpoints: /internal/media/* enabled (INTERNAL_MEDIA_TOKEN set)'
    : 'Media endpoints: /internal/media/* DISABLED until INTERNAL_MEDIA_TOKEN is set',
);

// Booleans only — never keys, secrets, refresh tokens or folder ids.
app.log.info(
  `Prompt generation: xai.live=${env.promptGeneration.xai.live} drive.live=${env.promptGeneration.drive.live} drive.folderOverride=${Boolean(env.promptGeneration.drive.folderId)}`,
);

/**
 * RESTART RECOVERY, RUN BEFORE THE PORT OPENS.
 *
 * A deploy or a crash mid-batch leaves rows in `generating` or `uploading`.
 * This is the sweep that puts them back to work: an already-generated image is
 * re-uploaded from the spool rather than regenerated, a completed output is
 * never touched, and a job recovered too many times is abandoned instead of
 * looping forever.
 *
 * The equivalent in the older generation module exists and is called by
 * nothing, which is why a crash strands its jobs. This one is wired in — and
 * its failure is logged rather than fatal, because a recovery problem must not
 * stop the API from serving.
 */
try {
  const recovery = await recoverInterruptedPromptJobs(
    db,
    selectPromptGenerationDeps(env.promptGeneration, db),
  );
  if (recovery.requeuedJobs + recovery.requeuedUploads + recovery.abandonedJobs > 0) {
    app.log.info(
      `Prompt generation recovery: requeued ${recovery.requeuedJobs} job(s) and ${recovery.requeuedUploads} pending upload(s), abandoned ${recovery.abandonedJobs}`,
    );
  }
} catch (err) {
  app.log.error({ err }, 'Prompt generation recovery failed');
}

try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
