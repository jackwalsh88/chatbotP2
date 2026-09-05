import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import HeroMedia from '../HeroMedia';
import PlayWithMeCarousel from './PlayWithMeCarousel';
import SwipeCard from '../SwipeCard';
import ProfileHero from '../profile/ProfileHero';
import type { PublicPlayWithMeCard } from '../../lib/api';
import type { CharacterMediaItem } from '../../lib/media';

/**
 * THE RAIL CROPS TOWARD THE HEAD.
 *
 * Every clip in production is portrait -- 9:16 (0.5625), 640x1152 (0.5556),
 * 544x960 (0.5667), 768x1168 (0.6575) -- and the Play with me card is 3:4.
 * `object-cover` therefore discards 12-26% of a clip's height, and the CSS
 * default split it evenly, taking up to 12.5% off the TOP. Measured on the live
 * rail that clipped hairlines.
 *
 * The fix anchors at 12%. These pin that it is applied on the rail and NOWHERE
 * else: the option is opt-in and its default emits nothing, so every other
 * surface sharing `HeroMedia` renders exactly what it did before.
 */

const card = (id = 'c1'): PublicPlayWithMeCard => ({
  id,
  displayName: `Name ${id}`,
  apparentAgeBand: 'late 20s',
  categories: [{ slug: 'sexy', name: 'Sexy' }],
  clip: {
    id: `a-${id}`,
    mediaType: 'video',
    url: `/api/media/assets/a-${id}/file`,
    characterId: id,
    characterName: `Name ${id}`,
  },
});

const router = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('Play with me anchors its crop toward the head', () => {
  const html = router(<PlayWithMeCarousel characters={[card('a'), card('b')]} />);

  it('applies the upper focal point to every card', () => {
    expect((html.match(/object-\[center_12%\]/g) ?? []).length).toBe(2);
  });

  it('keeps the 3:4 card and object-cover — no letterboxing, no resize', () => {
    expect((html.match(/aspect-\[3\/4\]/g) ?? []).length).toBe(2);
    expect(html).toContain('object-cover');
    expect(html).not.toContain('object-contain');
    expect(html).toContain('w-40');
  });

  it('preserves the card’s gradient, chips, name, age and link', () => {
    expect(html).toContain('bg-gradient-to-t');
    expect(html).toContain('Sexy');
    expect(html).toContain('Online');
    expect(html).toContain('href="/characters/a"');
    expect(html).toContain('snap-start');
  });
});

describe('the focal option is opt-in and changes nothing by default', () => {
  it('HeroMedia emits no object-position unless asked', () => {
    const html = renderToStaticMarkup(
      <HeroMedia media={{ kind: 'video', src: 'https://api.example/x.mp4' }} alt="x" />,
    );
    expect(html).toContain('object-cover');
    expect(html).not.toContain('object-[');
  });

  it('applies to an image the same way it applies to a video', () => {
    const html = renderToStaticMarkup(
      <HeroMedia media={{ kind: 'image', src: 'https://api.example/x.png' }} alt="x" focal="upper" />,
    );
    expect(html).toContain('object-[center_12%]');
  });

  it('does not disturb `fit` — the viewer still gets contain', () => {
    const html = renderToStaticMarkup(
      <HeroMedia media={{ kind: 'image', src: 'https://api.example/x.png' }} alt="x" fit="contain" />,
    );
    expect(html).toContain('object-contain');
    expect(html).not.toContain('object-[');
  });

  /**
   * The Favourites tile is the SAME 3:4 portrait card as a rail card, so it had
   * the same crop and is opted in too. Asserted on the source because the page
   * fetches on mount, so a static render is its loading skeleton rather than a
   * tile. Comments are stripped first: the file explains the framing in prose,
   * and matching that would pass on the documentation instead of the code.
   */
  it('the Favourites tile opts in as well', () => {
    const code = readFileSync(
      fileURLToPath(new URL('../../pages/FavouritesPage.tsx', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('focal="upper"');
    expect(code).toContain('aspect-[3/4]');
  });

  /**
   * The surfaces that share `HeroMedia` and were NOT asked to change. This
   * proves the default is genuinely inert for them rather than assuming it.
   */
  it('the swipe card and the profile hero are untouched', () => {
    const swipe = router(<SwipeCard character={card('s')} />);
    const item: CharacterMediaItem = {
      id: 'h1',
      media: { kind: 'video', src: 'https://api.example/h1.mp4' },
      premium: false,
    };
    const hero = router(
      <ProfileHero items={[item]} name="Amber" age={28} onBack={() => {}} onOpen={() => {}} />,
    );
    for (const html of [swipe, hero]) {
      expect(html).toContain('object-cover');
      expect(html).not.toContain('object-[');
    }
  });
});
