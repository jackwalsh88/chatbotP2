import { useEffect, useRef, useState } from 'react';
import { useInViewport } from '../hooks/useInViewport';
import type { HeroMedia as HeroMediaModel } from '../lib/media';

/**
 * The visual hero of a discovery card (US-19).
 *
 * Renders, in order of preference, a looping muted inline video, a still image,
 * or an initial-letter placeholder. Degrades gracefully at runtime:
 *   - a video that fails to load falls back to its poster image, then to the
 *     placeholder;
 *   - an image that fails to load falls back to the placeholder;
 * so the card never shows a broken-media icon. A subtle shimmer covers the
 * media until it can paint.
 *
 * Media-provider agnostic: it only consumes opaque URLs resolved upstream by
 * `resolveHeroMedia`, so a future real video provider drops in with no change
 * here.
 */
/**
 * Full class names, never interpolated. Tailwind scans source text for literal
 * class strings, so `object-${fit}` would be invisible to it and could be
 * purged from the build.
 */
const FIT_CLASS = {
  cover: 'h-full w-full object-cover',
  contain: 'h-full w-full object-contain',
} as const;

/**
 * WHERE `object-cover` KEEPS ITS ANCHOR when it has to discard part of a clip.
 *
 * Every clip in production is portrait -- measured 9:16 (0.5625), 640x1152
 * (0.5556), 544x960 (0.5667) and 768x1168 (0.6575) -- and every frame that
 * renders one is wider than that. `object-cover` fills the width and throws the
 * vertical overflow away, and the CSS default splits it evenly top and bottom.
 *
 * An even split is the wrong default for pictures of people. A portrait clip
 * puts the head near the top, so half of the overflow lands on the face: in the
 * Play with me rail's 3:4 card that is 12.5% of a 9:16 clip gone from the top,
 * which clipped hairlines and foreheads across the rail.
 *
 * `upper` anchors at 12% instead of 50%, so about a tenth of the loss comes off
 * the top and the rest off the floor. The SAME 12% the Home hero uses, so the
 * two surfaces frame their content alike -- see HeroCarousel, which reaches it
 * through ClipMedia's `className` because that component takes one.
 *
 * ── THE DEFAULT IS UNCHANGED ─────────────────────────────────────────────────
 *
 * `center` emits NO object-position class at all, so every existing caller --
 * the swipe card, the profile hero, the media viewer, the favourites tile --
 * renders byte-for-byte what it rendered before. This is opt-in per surface
 * because the right anchor depends on how much the frame actually crops, and
 * only the caller knows its own shape.
 *
 * The class strings are literal for the same reason `FIT_CLASS` above is:
 * Tailwind scans source text, so an interpolated value would be purged.
 */
const FOCAL_CLASS = {
  center: '',
  upper: 'object-[center_12%]',
} as const;

export type HeroMediaFocal = keyof typeof FOCAL_CLASS;

export default function HeroMedia({
  media,
  alt,
  className,
  fit = 'cover',
  focal = 'center',
  lazy = false,
}: {
  media: HeroMediaModel;
  alt: string;
  className?: string;
  /**
   * How the media fills its frame.
   *
   * 'cover' — the default, and what every pre-existing caller gets — crops to
   * fill, which is right for the edge-to-edge discovery cards this component
   * was built for.
   *
   * 'contain' shows the whole asset, letterboxed. Opt-in, added for the chat
   * full-screen viewer, where a photo someone was deliberately sent has to be
   * seen whole rather than cropped to a card's shape.
   */
  fit?: 'cover' | 'contain';
  /**
   * Which part of an over-tall clip survives the crop. Defaults to `center`,
   * the CSS default and what every pre-existing caller gets. A surface whose
   * frame crops far enough to reach a face opts into `upper`.
   */
  focal?: HeroMediaFocal;
  /**
   * OPT-IN deferred loading, for surfaces that mount many of these at once.
   *
   * Off by default on purpose. This component also backs chat media, the media
   * viewer, the swipe deck and Character Detail — surfaces where the media is
   * the thing the user just asked for, and where waiting for an observer would
   * be a regression rather than a saving. Only the Play with me rail, which
   * mounts a card per character, opts in.
   */
  lazy?: boolean;
}) {
  const [videoFailed, setVideoFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { near, visible } = useInViewport(videoRef, { disabled: !lazy });
  const [fetched, setFetched] = useState(false);
  const shouldLoad = !lazy || near || fetched;

  // Reset transient state whenever the underlying media changes (e.g. deck advances).
  const mediaKey = media.kind === 'placeholder' ? `p:${media.initial}` : `${media.kind}:${media.src}`;
  useEffect(() => {
    setVideoFailed(false);
    setImageFailed(false);
    setReady(false);
  }, [mediaKey]);

  // Decide the effective element after applying runtime failures.
  const showVideo = media.kind === 'video' && !videoFailed;
  const posterAsImage =
    media.kind === 'video' && videoFailed && media.poster
      ? ({ kind: 'image', src: media.poster } as const)
      : null;
  const effectiveImage =
    media.kind === 'image' ? media : posterAsImage ? posterAsImage : null;
  const showImage = !!effectiveImage && !imageFailed;

  useEffect(() => {
    if (shouldLoad && !fetched) setFetched(true);
  }, [shouldLoad, fetched]);

  // Pause an off-screen card rather than leaving a decoder running on something
  // nobody can see. Buffered bytes are kept; only the work stops.
  useEffect(() => {
    if (!lazy) return;
    const el = videoRef.current;
    if (!el || !showVideo || !shouldLoad) return;
    if (visible) {
      const attempt = el.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } else {
      // Unconditional, for the same reason ClipMedia does it: a `paused` check
      // loses the race against an autoplay that has not begun yet.
      el.pause();
    }
  }, [lazy, visible, showVideo, shouldLoad]);

  const initial =
    media.kind === 'placeholder' ? media.initial : (alt.charAt(0) || '?').toUpperCase();

  return (
    <div className={`relative h-full w-full overflow-hidden bg-zinc-900 ${className ?? ''}`}>
      {showVideo ? (
        <video
          key={mediaKey}
          ref={videoRef}
          {...(shouldLoad ? { src: media.src } : {})}
          poster={media.poster}
          autoPlay={!lazy || visible}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={alt}
          onCanPlay={() => setReady(true)}
          onLoadedData={() => setReady(true)}
          onError={() => setVideoFailed(true)}
          className={`${FIT_CLASS[fit]} ${FOCAL_CLASS[focal]}`.trim()}
        />
      ) : showImage && effectiveImage ? (
        <img
          key={mediaKey}
          src={effectiveImage.src}
          alt={alt}
          loading="lazy"
          onLoad={() => setReady(true)}
          onError={() => setImageFailed(true)}
          className={`${FIT_CLASS[fit]} ${FOCAL_CLASS[focal]}`.trim()}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950">
          <span className="text-8xl font-semibold text-rose-500/70">{initial}</span>
        </div>
      )}

      {/* Loading shimmer — hidden once the media can paint or when showing the placeholder. */}
      {!ready && (showVideo || showImage) && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800 to-zinc-900"
        />
      )}
    </div>
  );
}
