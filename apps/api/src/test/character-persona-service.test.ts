import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CharacterPersona } from '@over18/shared';
import { characterPersonas, characterVisualAssets, characters, users } from '../db/schema.js';
import { SEED_CHARACTERS } from '../db/seed-data.js';
import { seedCharacters } from '../db/seed.js';
import { createCharacterDraft } from '../services/character-service.js';
import { activateVisualIdentityVersion, createVisualIdentityVersion } from '../services/visual-identity-service.js';
import type { PersonaGenerator } from '../services/character-persona-generator.js';
import { PersonaGeneratorError } from '../services/character-persona-generator.js';
import {
  CharacterPersonaRegenerationError,
  CharacterPersonaValidationError,
  getCharacterPersona,
  regenerateCharacterPersona,
  saveCharacterPersona,
  validateCharacterPersona,
} from '../services/character-persona-service.js';
import {
  createTestContext,
  destroyTestContext,
  extractSessionCookie,
  migrateTestDb,
  truncateAll,
  type TestContext,
} from './helpers.js';

/**
 * NOTE ON THIS FILE'S EXECUTION STATE: written against the real test-DB
 * harness (createTestContext/migrateTestDb/truncateAll, same pattern as
 * visual-identity.test.ts and library-upload.test.ts) but NOT executed in
 * this sandbox — no Postgres is reachable here (embedded-postgres's native
 * initdb hits an EACCES at the process-spawn layer even with sandboxing
 * disabled). Run with `npx vitest run src/test/character-persona-service.test.ts`
 * against a real *_test database before merging.
 */

const LUNA = SEED_CHARACTERS.find((c) => c.name === 'luna')!;

/** A minimal valid PNG (1x1), same fixture library-upload.test.ts uses. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pngMultipart() {
  const boundary = '----personaboundary1234';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, PNG, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let ctx: TestContext;

beforeAll(async () => {
  migrateTestDb();
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await truncateAll(ctx);
  await seedCharacters(ctx.db);
});

async function adminCookie(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'op@example.com', password: 'correct horse battery staple' },
  });
  const c = extractSessionCookie(res)!;
  await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.email, 'op@example.com'));
  return `${c.name}=${c.value}`;
}

/** Fresh character with a real, uploaded, canonical reference image on disk. */
async function characterWithAvatar(): Promise<string> {
  const character = await createCharacterDraft(ctx.db, { name: `nova-${Date.now()}` });
  const identity = await createVisualIdentityVersion(
    ctx.db,
    character.id,
    { apparentAgeBand: 'adult' },
    { label: 'Test identity' },
  );
  const active = await activateVisualIdentityVersion(ctx.db, identity.id);

  const cookie = await adminCookie();
  const { payload, headers } = pngMultipart();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/admin/identities/${active.id}/references`,
    payload,
    headers: { ...headers, cookie },
  });
  expect(res.statusCode).toBe(201);
  return character.id;
}

const stubGenerator = (persona: CharacterPersona): PersonaGenerator => async () => persona;
const throwingGenerator = (error: PersonaGeneratorError): PersonaGenerator => async () => {
  throw error;
};

describe('validateCharacterPersona', () => {
  it('accepts a full persona and cleans it', () => {
    const persona = validateCharacterPersona({
      age: 27,
      occupation: '  second-year ER nurse  ',
      hobbies: ['night runs', 'trashy reality TV'],
    });
    expect(persona.age).toBe(27);
    expect(persona.occupation).toBe('second-year ER nurse');
    expect(persona.hobbies).toEqual(['night runs', 'trashy reality TV']);
  });

  it('drops unknown keys rather than surfacing them', () => {
    const persona = validateCharacterPersona({ occupation: 'nurse', race: 'x', religion: 'y' });
    expect(persona).not.toHaveProperty('race');
    expect(persona).not.toHaveProperty('religion');
  });

  it('rejects a non-object payload', () => {
    expect(() => validateCharacterPersona('nope')).toThrow(CharacterPersonaValidationError);
    expect(() => validateCharacterPersona(null)).toThrow(CharacterPersonaValidationError);
  });

  it('rejects an age under 18', () => {
    expect(() => validateCharacterPersona({ age: 17 })).toThrow(CharacterPersonaValidationError);
    expect(() => validateCharacterPersona({ age: 3.5 })).toThrow(CharacterPersonaValidationError);
  });

  it('rejects an ageRange or lifeStage denoting a minor', () => {
    expect(() => validateCharacterPersona({ ageRange: 'teenager' })).toThrow(
      CharacterPersonaValidationError,
    );
    expect(() => validateCharacterPersona({ lifeStage: 'high school student' })).toThrow(
      CharacterPersonaValidationError,
    );
  });

  it('accepts an empty object — every field is optional', () => {
    expect(validateCharacterPersona({})).toEqual({});
  });
});

describe('getCharacterPersona / saveCharacterPersona', () => {
  it('returns null when no persona row exists yet', async () => {
    expect(await getCharacterPersona(ctx.db, LUNA.id)).toBeNull();
  });

  it('upserts on first save and records editedFields', async () => {
    const row = await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    expect(row.persona.occupation).toBe('bartender');
    expect(row.editedFields).toEqual(['occupation']);
  });

  it('merges a second partial edit and dedupes editedFields', async () => {
    await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    const row = await saveCharacterPersona(ctx.db, LUNA.id, {
      occupation: 'bartender', // re-saved — must not duplicate in editedFields
      hobbies: ['mixology'],
    });
    expect(row.persona.occupation).toBe('bartender');
    expect(row.persona.hobbies).toEqual(['mixology']);
    expect(row.editedFields.sort()).toEqual(['hobbies', 'occupation']);
  });

  it('rejects an invalid partial edit without touching the existing persona', async () => {
    await saveCharacterPersona(ctx.db, LUNA.id, { occupation: 'bartender' });
    await expect(saveCharacterPersona(ctx.db, LUNA.id, { age: 15 })).rejects.toThrow(
      CharacterPersonaValidationError,
    );
    const row = await getCharacterPersona(ctx.db, LUNA.id);
    expect(row!.persona.occupation).toBe('bartender');
  });
});

describe('regenerateCharacterPersona', () => {
  it('fails with no_source_image before calling the generator at all', async () => {
    const character = await createCharacterDraft(ctx.db, { name: `no-avatar-${Date.now()}` });
    let called = false;
    const generator: PersonaGenerator = async () => {
      called = true;
      return {};
    };
    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: character.displayName },
        character.id,
        generator,
      ),
    ).rejects.toThrow(CharacterPersonaRegenerationError);
    expect(called).toBe(false);
  });

  it('on success, stores the persona, sourceAssetId and generatedAt', async () => {
    const characterId = await characterWithAvatar();
    const row = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'barista', age: 24 }),
    );
    expect(row.persona.occupation).toBe('barista');
    expect(row.persona.age).toBe(24);
    expect(row.sourceAssetId).not.toBeNull();
    expect(row.generatedAt).not.toBeNull();
    expect(row.editedFields).toEqual([]); // regeneration never adds to editedFields
  });

  it('THE CORE PROPERTY: an explicitly edited field survives regeneration', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'hand-edited occupation' });

    const row = await regenerateCharacterPersona(
      ctx.db,
      { displayName: 'Nova' },
      characterId,
      stubGenerator({ occupation: 'generated occupation', age: 30 }),
    );
    expect(row.persona.occupation).toBe('hand-edited occupation'); // untouched
    expect(row.persona.age).toBe(30); // fresh field DOES update
    expect(row.editedFields).toEqual(['occupation']);
  });

  it('skips references with no readable file and uses the first one that has bytes', async () => {
    // The real-world shape this was found in: a seeded placeholder reference
    // (external locator, no file on disk, explicit position so it sorts
    // FIRST) alongside a genuinely uploaded one (position null, sorts last).
    // Taking references[0] blindly made such a character un-regenerable.
    const character = await createCharacterDraft(ctx.db, { name: `mixed-${Date.now()}` });
    const identity = await createVisualIdentityVersion(
      ctx.db,
      character.id,
      { apparentAgeBand: 'adult' },
      { label: 'Test identity' },
    );
    const active = await activateVisualIdentityVersion(ctx.db, identity.id);

    // A placeholder canonical reference with no real file, positioned first.
    await ctx.db.insert(characterVisualAssets).values({
      characterId: character.id,
      visualIdentityId: active.id,
      kind: 'reference',
      status: 'approved',
      isCanonical: true,
      position: 1,
      storageKey: 'https://example.invalid/placeholder.png',
      provenance: { source: 'seed-placeholder' },
    });

    // A real upload lands after it, with position null.
    const cookie = await adminCookie();
    const { payload, headers } = pngMultipart();
    const uploaded = await ctx.app.inject({
      method: 'POST',
      url: `/admin/identities/${active.id}/references`,
      payload,
      headers: { ...headers, cookie },
    });
    expect(uploaded.statusCode).toBe(201);

    const row = await regenerateCharacterPersona(
      ctx.db,
      { displayName: character.displayName },
      character.id,
      stubGenerator({ occupation: 'barista' }),
    );
    expect(row.persona.occupation).toBe('barista');
    // Provenance points at the asset that actually supplied the bytes.
    expect(row.sourceAssetId).toBe(uploaded.json().assetId);
  });

  it('a generator failure leaves the persona row completely untouched', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'bartender' });
    const before = await getCharacterPersona(ctx.db, characterId);

    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: 'Nova' },
        characterId,
        throwingGenerator(new PersonaGeneratorError('unavailable', 'boom')),
      ),
    ).rejects.toThrow(PersonaGeneratorError);

    const after = await getCharacterPersona(ctx.db, characterId);
    expect(after).toEqual(before);
  });

  it('a generator failure on a character with NO existing persona creates no row', async () => {
    const characterId = await characterWithAvatar();
    await expect(
      regenerateCharacterPersona(
        ctx.db,
        { displayName: 'Nova' },
        characterId,
        throwingGenerator(new PersonaGeneratorError('invalid_output', 'boom')),
      ),
    ).rejects.toThrow(PersonaGeneratorError);
    expect(await getCharacterPersona(ctx.db, characterId)).toBeNull();
  });
});

describe('character_personas cleanup', () => {
  it('is removed when its character is deleted (cascade)', async () => {
    const characterId = await characterWithAvatar();
    await saveCharacterPersona(ctx.db, characterId, { occupation: 'temp' });
    await ctx.db.delete(characters).where(eq(characters.id, characterId));
    const [row] = await ctx.db
      .select()
      .from(characterPersonas)
      .where(eq(characterPersonas.characterId, characterId));
    expect(row).toBeUndefined();
  });
});
