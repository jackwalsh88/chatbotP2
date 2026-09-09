import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './client.js';
import { characters, characterVisualAssets, characterVisualIdentities } from './schema.js';
import { SEED_CHARACTERS, SEED_VISUAL_ASSETS, SEED_VISUAL_IDENTITIES } from './seed-data.js';

/**
 * Idempotent character seeding: upserts the deterministic seed characters by
 * their fixed UUIDs. Safe to run repeatedly (locally, in CI, or on Railway) —
 * reruns update the seeded rows and never create duplicates or touch other rows.
 *
 * Usage: npm run db:seed -w apps/api   (reads DATABASE_URL)
 */
export async function seedCharacters(db: ReturnType<typeof createDb>['db']): Promise<number> {
  for (const seed of SEED_CHARACTERS) {
    await db
      .insert(characters)
      .values(seed)
      .onConflictDoUpdate({
        target: characters.id,
        set: {
          name: seed.name,
          displayName: seed.displayName,
          profileImage: seed.profileImage,
          shortBio: seed.shortBio,
          personality: seed.personality,
          interests: seed.interests,
          conversationStyle: seed.conversationStyle,
          systemPrompt: seed.systemPrompt,
          status: seed.status,
          updatedAt: new Date(),
        },
      });
  }
  return SEED_CHARACTERS.length;
}

/**
 * Idempotent US-16B visual-identity seeding: upserts one active Visual Identity
 * and its approved canonical reference assets per seed character (fixed UUIDs).
 * Placeholder images only — see seed-data.ts. Safe to re-run.
 */
export async function seedVisualIdentities(
  db: ReturnType<typeof createDb>['db'],
): Promise<{ identities: number; assets: number }> {
  for (const seed of SEED_VISUAL_IDENTITIES) {
    await db
      .insert(characterVisualIdentities)
      .values(seed)
      .onConflictDoUpdate({
        target: characterVisualIdentities.id,
        set: {
          characterId: seed.characterId,
          version: seed.version,
          status: seed.status,
          visualDna: seed.visualDna,
          label: seed.label,
          updatedAt: new Date(),
        },
      });
  }
  for (const seed of SEED_VISUAL_ASSETS) {
    await db
      .insert(characterVisualAssets)
      .values(seed)
      .onConflictDoUpdate({
        target: characterVisualAssets.id,
        set: {
          characterId: seed.characterId,
          visualIdentityId: seed.visualIdentityId,
          kind: seed.kind,
          status: seed.status,
          isCanonical: seed.isCanonical,
          position: seed.position,
          storageKey: seed.storageKey,
          contentRating: seed.contentRating,
          provenance: seed.provenance,
          updatedAt: new Date(),
        },
      });
  }
  return { identities: SEED_VISUAL_IDENTITIES.length, assets: SEED_VISUAL_ASSETS.length };
}

/**
 * Run directly: node dist/db/seed.js (or via the db:seed npm script).
 *
 * WHY fileURLToPath AND NOT `file://${process.argv[1]}`. The string form is
 * correct on Linux and silently WRONG on Windows: `import.meta.url` is
 * `file:///C:/path/seed.ts` while argv[1] is `C:\path\seed.ts`, so the
 * comparison never matches, the block never runs, and `npm run db:seed`
 * exits 0 having seeded nothing at all. Comparing resolved filesystem paths
 * is platform-neutral, so seeding works the same locally on Windows, on
 * Linux and on Railway.
 */
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is not set — cannot seed.');
    process.exit(1);
  }
  const { db, pool } = createDb(databaseUrl);
  const count = await seedCharacters(db);
  const visual = await seedVisualIdentities(db);
  console.log(
    `Seeded ${count} characters, ${visual.identities} visual identities, ${visual.assets} canonical assets.`,
  );
  await pool.end();
}
