import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ClipMedia from './ClipMedia';
import HeroCarousel from './HeroCarousel';
import { MemoryRouter } from 'react-router-dom';
import type { PublicClip } from '../../lib/api';

/**
 * Deferred loading, and the promise that it changes nothing visible.
 *
 * These tests run in node with no DOM, so `IntersectionObserver` is undefined —
 * which is exactly the fallback path `useInViewport` is built around. In that
 * environment every clip must still render its real `src`, because
 * server-rendered markup has no observer to wait for and a blank first paint
 * would be a genuine regression rather than an optimisation.
 *
 * The browser-only half — that off-screen clips defer their fetch and pause —
 * cannot be asserted here and is measured in the browser performance run
 * instead. What IS pinned here is that the markup, attributes and playback
 * flags are untouched.
 */

const clip = (id: string, mediaType: 'image' | 'video' = 'video'): PublicClip => ({
  id,
  mediaType,
  url: `/api/media/assets/${id}/file`,
  characterId: `char-${id}`,
  characterName: `Nova ${id}`,
});

describe('ClipMedia keeps its markup contract', () => {
  it('renders the real src where there is no IntersectionObserver', () => {
    const markup = renderToStaticMarkup(<ClipMedia clip={clip('a')} autoPlay />);
    expect(markup).toContain('/api/media/assets/a/file');
    expect(markup).toContain('<video');
  });

  it('keeps autoplay, muted, loop, playsInline and preload=metadata', () => {
    const markup = renderToStaticMarkup(<ClipMedia clip={clip('b')} autoPlay />);
    for (const attr of ['autoplay', 'muted', 'loop', 'playsinline']) {
      expect(markup).toContain(attr);
    }
    expect(markup).toContain('preload="metadata"');
  });

  it('still renders an image clip as an image, lazily', () => {
    const markup = renderToStaticMarkup(<ClipMedia clip={clip('c', 'image')} />);
    expect(markup).toContain('<img');
    expect(markup).toContain('loading="lazy"');
  });

  it('still degrades to a neutral frame for a missing clip', () => {
    const markup = renderToStaticMarkup(<ClipMedia clip={null} />);
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('<img');
  });

  it('`active={false}` withholds autoplay and changes NOTHING else', () => {
    const on = renderToStaticMarkup(<ClipMedia clip={clip('d')} autoPlay active />);
    const off = renderToStaticMarkup(<ClipMedia clip={clip('d')} autoPlay active={false} />);

    // Autoplay is the ONLY difference — that is the whole mechanism. Binding
    // the attribute (rather than pausing after the fact) is what stopped an
    // inactive Hero slide starting before the pause effect could run.
    expect(on).toContain('autoplay');
    expect(off).not.toContain('autoplay');
    expect(off).toBe(on.replace(' autoplay=""', ''));

    // Everything that affects layout or identity is untouched.
    for (const markup of [on, off]) {
      expect(markup).toContain('/api/media/assets/d/file');
      expect(markup).toContain('muted');
      expect(markup).toContain('loop');
      expect(markup).toContain('playsinline');
      expect(markup).toContain('preload="metadata"');
    }
    // `active` is never emitted as an attribute.
    expect(off).not.toContain('active=');
  });

  it('leaks no storage key or filesystem path', () => {
    const markup = renderToStaticMarkup(<ClipMedia clip={clip('e')} autoPlay />);
    expect(markup).not.toContain('storageKey');
    expect(markup).not.toContain('/app/var/media');
  });
});

describe('the Hero plays only its active slide', () => {
  const render = (clips: PublicClip[]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <HeroCarousel clips={clips} />
      </MemoryRouter>,
    );

  it('keeps every slide, its crop and its scroll-snap geometry', () => {
    const markup = render([clip('h1'), clip('h2'), clip('h3')]);
    /**
     * SQUARE SINCE THE FRAMING FIX. The banner was 16:11, which showed only 39%
     * of a portrait clip and — with the crop centred — took 30.7% off the top,
     * removing the face. 1:1 shows 56% and the anchor moves to 12%, so the whole
     * subject reads. Snap behaviour and slide count are unchanged.
     */
    expect(markup.match(/aspect-square/g)).toHaveLength(3);
    expect(markup).not.toContain('aspect-[16/11]');
    expect(markup.match(/object-\[center_12%\]/g)).toHaveLength(3);
    expect(markup.match(/snap-center/g)).toHaveLength(3);
    expect(markup).toContain('flex snap-x snap-mandatory overflow-x-auto');
    expect(markup.match(/<video/g)).toHaveLength(3);
  });

  /**
   * The banner must stay edge to edge. 1:1 is wider than every production clip
   * (0.5556-0.6575), so `object-cover` always fills it: no letterboxing, no side
   * gutters, no narrower video inside the full-width frame.
   */
  it('stays full-bleed — cover, never contain', () => {
    const markup = render([clip('h1')]);
    expect(markup).toContain('object-cover');
    expect(markup).not.toContain('object-contain');
    expect(markup).toContain('w-full');
  });

  it('keeps the dot navigation and the approved overlay', () => {
    const markup = render([clip('h1'), clip('h2')]);
    expect(markup).toContain('Go to slide 1');
    expect(markup).toContain('Go to slide 2');
    expect(markup).toContain('bg-gradient-to-t from-zinc-950');
    expect(markup).toContain('Say hello');
  });

  it('renders nothing when the operator has assigned no clips', () => {
    expect(render([])).toBe('');
  });
});
