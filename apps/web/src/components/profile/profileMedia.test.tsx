import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import AboutTab from './AboutTab';
import type { PublicCharacter } from '@over18/shared';

/**
 * THE CHARACTER PROFILE RENDERS NO BUNDLED PoC MEDIA.
 *
 * The defect, reported from production with a screenshot: Amber's About tab
 * showed a "More of Amber" rail carrying tiles labelled "Off the clock" and
 * "Late night" -- EMBER's demo clips. `characterMedia.ts` mapped four slugs to
 * files under `/media/<name>/` and keyed the lookup on `character.name`, so a
 * character whose stable slug was `ember` and whose display name had been
 * changed to "Amber" was served another character's bundled files under her own
 * heading.
 *
 * These pin the removal at both levels: the rail is gone from the markup, and
 * the manifest module itself no longer exists for anything to import.
 */

const character = (over: Partial<PublicCharacter> = {}): PublicCharacter =>
  ({
    id: 'c1',
    name: 'ember',
    displayName: 'Amber',
    shortBio: 'Firecracker chef with a food truck.',
    personality: 'Bold, playful, and teasing.',
    conversationStyle: 'Quick, witty banter.',
    interests: ['street food', 'salsa dancing'],
    profileImage: 'https://img.example/amber.png',
    ...over,
  }) as PublicCharacter;

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe('About tab renders no media at all', () => {
  /** The exact production case: slug `ember`, display name "Amber". */
  const html = renderToStaticMarkup(<AboutTab character={character()} attributes={[]} />);

  it('has no "More of ..." rail', () => {
    expect(html).not.toContain('More of');
    expect(html).not.toContain('MORE OF');
  });

  it('renders no media element and no bundled path', () => {
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('/media/');
  });

  it('cannot leak another character’s demo clips through the slug', () => {
    // The two tiles from the screenshot, by their manifest labels.
    expect(html).not.toContain('Off the clock');
    expect(html).not.toContain('Late night');
    expect(html).not.toContain('Turning up the heat');
  });

  it('still renders the prose and facts it is responsible for', () => {
    const full = renderToStaticMarkup(
      <AboutTab
        character={character()}
        attributes={[{ label: 'Apparent age', value: 'adult (late-20s)' }]}
      />,
    );
    expect(full).toContain('Firecracker chef');
    expect(full).toContain('Bold, playful');
    expect(full).toContain('street food');
    expect(full).toContain('adult (late-20s)');
  });
});

describe('the legacy manifest is gone from the repository', () => {
  it('characterMedia.ts no longer exists', () => {
    expect(existsSync(src('../../lib/characterMedia.ts'))).toBe(false);
  });

  it('no Character Profile module imports it', () => {
    for (const file of [
      './AboutTab.tsx',
      './ProfileHero.tsx',
      './ProfileTabs.tsx',
      './PostsTab.tsx',
      '../../pages/CharacterDetailPage.tsx',
      '../../lib/media.ts',
    ]) {
      // CODE, not prose: these modules explain in comments which fallbacks they
      // deliberately no longer reach, and matching that explanation would fail
      // on the documentation rather than on the behaviour.
      const code = readFileSync(src(file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toContain("from '../../lib/characterMedia'");
      expect(code).not.toContain("from './characterMedia'");
      expect(code).not.toContain('characterVideos');
      expect(code).not.toContain('characterVideoItems');
      expect(code).not.toContain('characterHeroVideo');
    }
  });

  /**
   * `media.ts` is the shared resolver. With the manifest deleted, no bundled
   * path can be produced by any surface that uses it -- Profile included.
   */
  it('media.ts contains no bundled /media/ path', () => {
    const code = readFileSync(src('../../lib/media.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('/media/luna');
    expect(code).not.toContain('/media/ember');
    expect(code).not.toContain('/media/sage');
    expect(code).not.toContain('/media/maria');
  });
});
