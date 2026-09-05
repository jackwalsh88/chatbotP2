import { describe, it, expect } from 'vitest';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import {
  apparentAge,
  characterHeaderItems,
  characterMediaList,
  firstCanonicalImage,
  resolveHeroMedia,
  resolveRailMedia,
  type CharacterClipRef,
} from './media';

function character(overrides: Partial<PublicCharacter> = {}): PublicCharacter {
  return {
    id: 'c1',
    name: 'nova',
    displayName: 'Nova',
    profileImage: 'https://img.example/nova.png',
    shortBio: 'bio',
    personality: 'p',
    interests: [],
    conversationStyle: 's',
    ...overrides,
  };
}

function visual(
  canonicals: Array<{ id: string; position: number | null; imageUrl: string }>,
  attributes: Array<{ label: string; value: string }> = [],
): CharacterVisualIdentityResponse {
  return {
    identity:
      attributes.length > 0
        ? { characterId: 'c1', version: 1, label: 'v1', attributes }
        : { characterId: 'c1', version: 1, label: 'v1', attributes: [] },
    canonicalAssets: canonicals,
  };
}

describe('resolveHeroMedia', () => {
  it('is video-first when the character carries a video url (future API field)', () => {
    const withVideo = { ...character(), videoUrl: 'https://cdn.example/nova.mp4' } as PublicCharacter;
    const media = resolveHeroMedia(withVideo, null);
    expect(media.kind).toBe('video');
    if (media.kind === 'video') {
      expect(media.src).toBe('https://cdn.example/nova.mp4');
      // best available still becomes the poster
      expect(media.poster).toBe('https://img.example/nova.png');
    }
  });

  it('uses the visual identity poster for video when available', () => {
    const withVideo = { ...character(), videoUrl: 'https://cdn.example/nova.mp4' } as PublicCharacter;
    const media = resolveHeroMedia(
      withVideo,
      visual([{ id: 'a1', position: 0, imageUrl: 'https://img.example/canon.png' }]),
    );
    expect(media.kind === 'video' && media.poster).toBe('https://img.example/canon.png');
  });

  it('falls back to the first canonical image when there is no video', () => {
    const media = resolveHeroMedia(
      character(),
      visual([
        { id: 'a2', position: 1, imageUrl: 'https://img.example/second.png' },
        { id: 'a1', position: 0, imageUrl: 'https://img.example/first.png' },
      ]),
    );
    expect(media).toEqual({ kind: 'image', src: 'https://img.example/first.png' });
  });

  it('falls back to profileImage when there is no visual identity', () => {
    const media = resolveHeroMedia(character(), null);
    expect(media).toEqual({ kind: 'image', src: 'https://img.example/nova.png' });
  });

  it('falls back to an initial-letter placeholder when there is no media at all', () => {
    const media = resolveHeroMedia(character({ profileImage: null }), null);
    expect(media).toEqual({ kind: 'placeholder', initial: 'N' });
  });
});

describe('firstCanonicalImage', () => {
  it('picks the lowest-position asset and ignores blank urls', () => {
    expect(
      firstCanonicalImage(
        visual([
          { id: 'a2', position: 2, imageUrl: 'https://img.example/two.png' },
          { id: 'a1', position: 0, imageUrl: 'https://img.example/zero.png' },
        ]),
      ),
    ).toBe('https://img.example/zero.png');
    expect(firstCanonicalImage(visual([{ id: 'a1', position: 0, imageUrl: '   ' }]))).toBeUndefined();
    expect(firstCanonicalImage(null)).toBeUndefined();
  });
});

describe('characterMediaList', () => {
  it('opens with a free hero and gates the rest behind Premium (mock-filled) by default', () => {
    const items = characterMediaList(character(), null);
    expect(items).toHaveLength(6); // default minItems
    expect(items[0]?.premium).toBe(false); // hero is free
    expect(items[0]?.media).toEqual({ kind: 'image', src: 'https://img.example/nova.png' });
    expect(items.filter((i) => i.premium).length).toBe(5);
    expect(items.slice(1).every((i) => i.premium && i.mock)).toBe(true); // padded tiles are flagged mock
  });

  it('treats additional REAL canonical stills as free, viewable media', () => {
    const items = characterMediaList(
      character(),
      visual([
        { id: 'a1', position: 0, imageUrl: 'https://img.example/one.png' },
        { id: 'a2', position: 1, imageUrl: 'https://img.example/two.png' },
        { id: 'a3', position: 2, imageUrl: 'https://img.example/three.png' },
      ]),
    );
    const free = items.filter((i) => !i.premium);
    expect(free.length).toBe(3); // hero + 2 additional canonical
    expect(free[1]?.media).toEqual({ kind: 'image', src: 'https://img.example/two.png' });
    expect(items.filter((i) => i.premium).length).toBe(3); // padded to minItems 6
  });

  it('respects a custom minItems', () => {
    expect(characterMediaList(character(), null, { minItems: 3 })).toHaveLength(3);
  });
});

describe('apparentAge', () => {
  it('reads the "Apparent age" identity attribute when present', () => {
    expect(apparentAge(visual([], [{ label: 'Apparent age', value: 'adult (mid-20s)' }]))).toBe(
      'adult (mid-20s)',
    );
  });
  it('returns undefined when no age attribute exists', () => {
    expect(apparentAge(visual([], [{ label: 'Hair', value: 'dark' }]))).toBeUndefined();
    expect(apparentAge(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The CMS clip as a card's video
 *
 * THE GAP THIS CLOSES. A character created through the CMS could upload and
 * approve any number of videos and her public card stayed a still image
 * forever, because the only video source a card had was a hard-coded manifest
 * keyed on four seeded names. The card component is unchanged; what changed is
 * which data it is allowed to select from.
 * ------------------------------------------------------------------ */

const clip = (mediaType: 'image' | 'video', id = 'a1') => ({
  url: `/api/media/assets/${id}/file`,
  mediaType,
});

describe('a character’s CMS clip can be her card video', () => {
  it('uses an approved CMS VIDEO as the card’s video', () => {
    const media = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('video') } as never));
    expect(media.kind).toBe('video');
    // Absolutised against the API origin — the web app is a different origin.
    expect(media.kind === 'video' && media.src).toContain('/api/media/assets/a1/file');
  });

  it('does NOT treat a CMS image clip as a video', () => {
    const media = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('image') } as never));
    expect(media.kind).toBe('image');
  });

  it('posters the CMS video with the canonical still, then profileImage', () => {
    const withCanonical = resolveHeroMedia(
      character({ name: 'nova-cms', clip: clip('video') } as never),
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(withCanonical.kind === 'video' && withCanonical.poster).toContain('/assets/i1/file');

    const withProfile = resolveHeroMedia(character({ name: 'nova-cms', clip: clip('video') } as never));
    expect(withProfile.kind === 'video' && withProfile.poster).toBe('https://img.example/nova.png');
  });

  it('leaves a character with no clip exactly as she was', () => {
    // The field is optional: the older /api/characters payload has none, and
    // every existing caller must keep working untouched.
    const media = resolveHeroMedia(character({ name: 'unknown-to-manifest' }));
    expect(media.kind).toBe('image');
    expect(media.kind === 'image' && media.src).toBe('https://img.example/nova.png');
  });

  it('a null clip is handled like an absent one', () => {
    const media = resolveHeroMedia(character({ name: 'unknown-to-manifest', clip: null } as never));
    expect(media.kind).toBe('image');
  });
});

/**
 * THE BUNDLED PoC MANIFEST IS GONE, and these pin its absence.
 *
 * `characterMedia.ts` mapped four slugs -- luna, ember, sage, maria -- to demo
 * files under `/media/<name>/`. It was keyed on `character.name`, so a
 * character whose slug was `ember` and whose display name was "Amber" was
 * served Ember's clips under Amber's name. Reported from production.
 *
 * A seeded slug now resolves exactly like any other character: her CMS clip if
 * she has one, otherwise her identity still. No file under `/media/` can reach
 * any surface through this module.
 */
describe('the bundled PoC manifest cannot be resolved any more', () => {
  it('a seeded slug with an IMAGE clip gets her image, not a demo video', () => {
    const media = resolveHeroMedia(character({ name: 'luna', clip: clip('image') } as never));
    expect(media.kind).not.toBe('video');
    expect(JSON.stringify(media)).not.toContain('/media/luna');
  });

  it('a seeded slug with NO clip falls to her identity still, not a demo video', () => {
    const media = resolveHeroMedia(character({ name: 'luna' }));
    expect(media.kind).toBe('image');
    expect(JSON.stringify(media)).not.toContain('/media/');
  });

  it('no seeded slug can produce a bundled file', () => {
    for (const name of ['luna', 'ember', 'sage', 'maria'] as const) {
      const media = resolveHeroMedia(character({ name, clip: clip('image') } as never));
      expect(JSON.stringify(media)).not.toContain('/media/' + name);
    }
  });

  it('a CMS VIDEO outranks the manifest — an operator’s choice beats a constant', () => {
    const media = resolveHeroMedia(character({ name: 'luna', clip: clip('video', 'new') } as never));
    expect(media.kind === 'video' && media.src).toContain('/api/media/assets/new/file');
  });
});

/* ------------------------------------------------------------------ *
 * The HOME CHARACTER RAILS are clip-only
 *
 * THE DEFECT THIS CLOSES. Play with me rendered `resolveHeroMedia`, which uses
 * the CMS clip only when it is a VIDEO and otherwise falls through to
 * `firstCanonicalImage(visual) ?? profileImage` — the character's identity
 * image, shown as though it were her clip. `resolveRailMedia` cannot reach any
 * of those sources at all.
 * ------------------------------------------------------------------ */

describe('the Play with me rail renders a real video or NO CARD', () => {
  const video = { url: '/api/media/assets/vid/file', mediaType: 'video' as const };
  const image = { url: '/api/media/assets/img/file', mediaType: 'image' as const };

  it('renders the character\u2019s own approved VIDEO', () => {
    const media = resolveRailMedia(character({ clip: video } as never));
    expect(media?.kind).toBe('video');
    expect(media?.kind === 'video' && media.src).toContain('/api/media/assets/vid/file');
  });

  it('returns NULL when she has no eligible video \u2014 no card, no substitute', () => {
    // `character()` carries profileImage 'https://img.example/nova.png'.
    expect(resolveRailMedia(character({ clip: null } as never))).toBeNull();
  });

  it('NEVER falls back to profileImage', () => {
    const media = resolveRailMedia(character({ clip: null } as never));
    expect(JSON.stringify(media)).not.toContain('img.example');
  });

  it('NEVER falls back to the canonical/visual-identity image', () => {
    // resolveRailMedia takes no `visual` argument at all \u2014 the identity image
    // is not reachable from here by construction, not by convention.
    expect(resolveRailMedia.length).toBe(1);
    expect(resolveRailMedia(character({ clip: null } as never))).toBeNull();
  });

  it('NEVER falls back to the hard-coded manifest, even for a seeded name', () => {
    // Luna has a manifest entry. On a rail it must not be used.
    const media = resolveRailMedia(character({ name: 'luna', clip: null } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('/media/luna');
  });

  it('NEVER renders a placeholder \u2014 the old lettered tile is gone', () => {
    // It used to return { kind: 'placeholder', initial: 'N' }. A lettered tile
    // among video tiles is still a card claiming she has content.
    const media = resolveRailMedia(character({ displayName: 'Nova', clip: null } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('placeholder');
  });

  it('does NOT treat an image clip as rail media', () => {
    const media = resolveRailMedia(character({ clip: image } as never));
    expect(media).toBeNull();
    expect(JSON.stringify(media)).not.toContain('/assets/img/file');
  });

  it('a seeded character WITH an approved video plays that video', () => {
    // Maria/Ember/Luna resolve from their own content, not their reference image.
    const media = resolveRailMedia(character({ name: 'maria', clip: video } as never));
    expect(media?.kind === 'video' && media.src).toContain('/api/media/assets/vid/file');
    expect(JSON.stringify(media)).not.toContain('/media/maria');
  });
});

describe('the OTHER surfaces keep their image behaviour', () => {
  // resolveHeroMedia still serves the discovery grid, the swipe card and the
  // Character page, where showing a character's own image is correct. This
  // fix must not have leaked into them.
  it('resolveHeroMedia still falls back to profileImage', () => {
    const media = resolveHeroMedia(character({ name: 'not-in-manifest' }));
    expect(media.kind).toBe('image');
    expect(media.kind === 'image' && media.src).toBe('https://img.example/nova.png');
  });

  it('resolveHeroMedia still prefers the canonical image over profileImage', () => {
    const media = resolveHeroMedia(
      character({ name: 'not-in-manifest' }),
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(media.kind === 'image' && media.src).toContain('/assets/i1/file');
  });

  it('resolveHeroMedia no longer serves the seeded manifest videos', () => {
    // It used to return kind 'video' pointing at /media/luna/profile-04.mp4.
    const media = resolveHeroMedia(character({ name: 'luna' }));
    expect(media.kind).not.toBe('video');
  });
});

/* ------------------------------------------------------------------ *
 * The Character page's header deck.
 *
 * THE BUG THESE PIN. The header consulted exactly two sources: a hard-coded
 * four-name manifest (luna, ember, sage, maria) and `character.clip`. The
 * detail endpoint `/api/characters/:id` returns `PublicCharacter`, which has no
 * `clip` field at all — so for every character an operator created through the
 * CMS both sources were empty, `resolveHeroMedia` fell through to the still
 * image, and the header showed her canonical REFERENCE portrait as a static
 * picture no matter how many videos she had published.
 *
 * Her real videos were already on the page: the Posts tab fetches
 * `/api/characters/:id/clips`, which is reference-excluded and approval-gated
 * server-side. The header simply never looked at them.
 * ------------------------------------------------------------------ */

const headerClip = (
  id: string,
  mediaType: 'image' | 'video' = 'video',
): CharacterClipRef => ({
  id,
  mediaType,
  url: `/api/media/assets/${id}/file`,
});

describe('the Character header plays her own videos', () => {
  const cms = () => character({ name: 'not-in-manifest' });

  it('builds the deck from her publicly reachable VIDEO clips', () => {
    const items = characterHeaderItems(cms(), [headerClip('v1'), headerClip('v2')], null);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.media.kind === 'video')).toBe(true);
    const first = items[0]!.media;
    expect(first.kind === 'video' && first.src).toContain('/api/media/assets/v1/file');
  });

  it('resolves the locator against the API origin, not the web origin', () => {
    // The clip url is API-relative; a root-relative src would resolve against
    // the web app, which is a different origin in every deployment.
    const first = characterHeaderItems(cms(), [headerClip('v1')], null)[0]!.media;
    expect(first.kind === 'video' && first.src.startsWith('/api/')).toBe(false);
  });

  it('IGNORES image clips — the header is a video surface', () => {
    const items = characterHeaderItems(cms(), [headerClip('img', 'image'), headerClip('v1')], null);
    expect(items).toHaveLength(1);
    const only = items[0]!.media;
    expect(only.kind === 'video' && only.src).toContain('v1');
  });

  it('falls back to the EXISTING still when she has no video at all', () => {
    const items = characterHeaderItems(
      cms(),
      [headerClip('img', 'image')],
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.media.kind).toBe('image');
    expect(items[0]!.media.kind === 'image' && items[0]!.media.src).toContain('/assets/i1/file');
  });

  it('never returns an empty deck — the header always has something to render', () => {
    const items = characterHeaderItems(character({ name: 'nobody', profileImage: null }), [], null);
    expect(items).toHaveLength(1);
    expect(items[0]!.media.kind).toBe('placeholder');
  });

  it('gives a seeded character with NO CMS video her identity still, not a demo file', () => {
    // This used to return /media/luna/profile-04.mp4 from the bundled manifest.
    // The header now shows her own avatar, which is an identity image and is
    // never presented as a post.
    const items = characterHeaderItems(character({ name: 'luna' }), [], null);
    expect(items).toHaveLength(1);
    expect(items[0]!.media.kind).toBe('image');
    expect(JSON.stringify(items[0]!.media)).not.toContain('/media/luna');
  });
});

/* ------------------------------------------------------------------ *
 * PRECEDENCE: an operator's upload beats a constant in the source.
 *
 * REPORTED FROM PRODUCTION. Ember, Maria and Luna each had approved, publicly
 * reachable CMS videos — already powering their Play with me cards, and for
 * two of them Home Hero slots — while their Character headers still played the
 * bundled demo clips. Uploading real content to a seeded character changed
 * nothing an operator could see on her own page.
 *
 * The ids below are the REAL production asset ids, so these tests describe the
 * situation that was actually observed rather than an invented one.
 * ------------------------------------------------------------------ */

describe('a real CMS video beats the bundled manifest', () => {
  const PRODUCTION: Record<string, { clips: string[]; manifestHero: string }> = {
    ember: {
      clips: ['65e7dcc5-787a-4837-8dbc-834f8a4c3338', '09a81ef5-987d-4d75-83e6-ca766108cb90'],
      manifestHero: '/media/ember/hero.mp4',
    },
    maria: {
      clips: ['bfb0e247-ff9f-4b56-8ad7-cba83ad49e24', 'f8503c47-0111-431b-83f2-07a26a766675'],
      manifestHero: '/media/maria/hero.mp4',
    },
    luna: {
      clips: ['1834e683-7eec-466c-b6fb-6aa17a7632f3', '26ea99ed-23a9-4790-ae5e-75243b988829'],
      manifestHero: '/media/luna/profile-04.mp4',
    },
  };

  for (const [name, { clips, manifestHero }] of Object.entries(PRODUCTION)) {
    it(`${name}: plays her own videos, not ${manifestHero}`, () => {
      const items = characterHeaderItems(
        character({ name }),
        clips.map((id) => headerClip(id)),
        null,
      );

      expect(items).toHaveLength(clips.length);
      const srcs = items.map((i) => (i.media.kind === 'video' ? i.media.src : ''));
      for (const id of clips) {
        expect(srcs.some((s) => s.includes(id))).toBe(true);
      }
      // Not one bundled file survives in her header.
      expect(srcs.every((s) => !s.startsWith('/media/'))).toBe(true);
      expect(srcs).not.toContain(manifestHero);
    });
  }

  it('an image-only CMS collection is still not a header, and gets no demo file', () => {
    // The ordering must not be "CMS list is non-empty" -- it must be "CMS list
    // contains a VIDEO". An image-only collection is not a header. It used to
    // fall through to /media/ember/hero.mp4; it now falls to her own still.
    const items = characterHeaderItems(
      character({ name: 'ember' }),
      [headerClip('an-image', 'image')],
      null,
    );
    expect(items[0]!.media.kind).not.toBe('video');
    expect(JSON.stringify(items[0]!.media)).not.toContain('/media/ember');
  });

  it('keeps the still fallback for a character with neither', () => {
    const items = characterHeaderItems(
      character({ name: 'not-in-manifest' }),
      [],
      visual([{ id: 'i1', position: 0, imageUrl: '/api/media/assets/i1/file' }]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.media.kind).toBe('image');
    expect(items[0]!.media.kind === 'image' && items[0]!.media.src).toContain('/assets/i1/file');
  });
});

describe('resolveHeroMedia is NOT affected by the header precedence change', () => {
  /**
   * The header and the swipe card resolve media through different functions.
   * Only `characterHeaderItems` changed; these pin `resolveHeroMedia`'s own
   * behaviour so a future edit cannot quietly move Home Hero, Play with me or
   * the swipe deck while "fixing the header".
   */
  it('serves NO manifest clip for a seeded character', () => {
    // Previously /media/ember/hero.mp4. The bundled manifest is deleted, so a
    // seeded slug resolves to her own identity image like anyone else.
    const media = resolveHeroMedia(character({ name: 'ember' }));
    expect(media.kind).not.toBe('video');
    expect(JSON.stringify(media)).not.toContain('/media/ember');
  });

  it('still prefers a CMS clip over the manifest, exactly as it always has', () => {
    const withClip = {
      ...character({ name: 'ember' }),
      clip: { url: '/api/media/assets/cms/file', mediaType: 'video' as const },
    };
    const media = resolveHeroMedia(withClip, null);
    expect(media.kind === 'video' && media.src).toContain('/api/media/assets/cms/file');
  });

  it('still falls back to the still image for a character with no video', () => {
    const media = resolveHeroMedia(character({ name: 'not-in-manifest' }));
    expect(media.kind).toBe('image');
    expect(media.kind === 'image' && media.src).toBe('https://img.example/nova.png');
  });

  it('rail media is still clip-only and never reaches the manifest', () => {
    expect(resolveRailMedia(character({ name: 'ember' }))).toBeNull();
  });
});

describe("the header cannot show her identity image as a 'video'", () => {
  /**
   * DEFENCE IN DEPTH. `/api/characters/:id/clips` already excludes
   * `kind = 'reference'` in SQL, so a canonical portrait never reaches this
   * function. This proves the client half independently: even if a reference
   * image were somehow in the list, it is an IMAGE and the video filter drops
   * it — it can never be dressed up as a video item.
   */
  it('drops an identity image handed to it, rather than treating it as a clip', () => {
    const identity = { id: 'ref', url: '/api/media/assets/ref/file', mediaType: 'image' as const };
    const items = characterHeaderItems(character({ name: 'not-in-manifest' }), [identity], null);
    expect(items.some((i) => i.media.kind === 'video')).toBe(false);
  });

  it('does not invent an image of its own when she has no media', () => {
    const items = characterHeaderItems(
      character({ name: 'not-in-manifest', profileImage: null }),
      [],
      null,
    );
    expect(items[0]!.media.kind).toBe('placeholder');
  });
});
