import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicClip } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * The Hero carousel (US-102.4).
 *
 * ADMIN-ASSIGNED CLIPS ONLY. The server sends exactly the clips an operator put
 * here, in their order. There is no performance input anywhere in this path —
 * this product records no views or plays, and the ticket says the
 * editorial/performance mixing rule is still unspecified, so nothing here
 * pretends to rank.
 *
 * The previous version composed its own slides: a hard-coded "Refer a friend,
 * get 85% off" promo plus the first three characters, with invented eyebrow and
 * headline copy. None of it was CMS-controlled. It is gone — an empty Hero now
 * renders nothing, which is the honest state when an operator has assigned no
 * clips.
 *
 * Native scroll-snap for paging, as before, so a natural horizontal swipe works
 * and the layout stays usable on desktop.
 */
export default function HeroCarousel({ clips }: { clips: PublicClip[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== active) setActive(i);
  };

  const goTo = (i: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  if (clips.length === 0) return null;

  return (
    <section aria-label="Featured" className="relative">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/*
          SQUARE, NOT 16:11 -- the banner ZOOMS OUT rather than cropping harder.

          Every clip in production is portrait: measured 9:16 (0.5625),
          640x1152 (0.5556), 544x960 (0.5667) and 768x1168 (0.6575). A 16:11
          band shows only 39% of a 9:16 clip's height, and `object-cover` split
          that loss evenly, so 30.7% came off the TOP -- exactly where the face
          is. On the live Home page Camila and Karen were both cropped to a chin.

          Re-anchoring the crop alone was tried and rejected: it rescues the head
          but leaves a head-and-shoulders sliver, which is not what a hero should
          show. Making the frame taller is the actual fix -- 1:1 shows 56% of the
          clip instead of 39%, so the whole subject reads, head and torso.

          WHY 1:1 AND NOT TALLER. 4:5 and 3:4 show still more, and at 375px wide
          they are 469px and 500px tall: the "Play with me" rail below drops off
          the first screen. A square hero is 375px, keeps the rail visible, and
          is still a 45% gain in visible clip. It is also the largest ratio that
          never letterboxes -- wider than every clip, so `object-cover` fills it
          edge to edge with no side gutters at any viewport width.
        */}
        {clips.map((clip, i) => (
          <div key={clip.id} className="relative aspect-square w-full shrink-0 snap-center">
            <div className="absolute inset-0">
              {/* ONLY THE ACTIVE SLIDE PLAYS. All three used to autoplay at
                  once: measured at readyState=4 with slides 2 and 3 decoding
                  off screen. `active` stops the decode; the neighbouring slide
                  still LOADS via ClipMedia's viewport margin, so swiping to it
                  finds bytes already arriving. Dimensions, crop, gradient,
                  overlay and scroll-snap are untouched. */}
              {/*
                THE REMAINING CROP COMES OFF THE BOTTOM.

                A square frame still discards ~44% of a 9:16 clip, and centring
                that would take 21.9% off the top -- enough to cut a face on
                content framed as tightly as Camila's. Anchoring at 12% takes
                5.3% from the top and the rest from the floor, which is what
                nobody is looking at.

                12% RATHER THAN 0%. Top-aligning wastes the frame on clips that
                carry headroom above the subject; 12% keeps a little of it and
                still clears the head on the tightest clip in production.
                Verified on all three assigned hero clips.

                THE OVERRIDE LIVES HERE, NOT IN ClipMedia. `className` is the
                prop that component already exposes for this (FeedView uses it
                for `object-contain`), so the shared default is untouched and no
                other surface -- the clip grid, the rails, Posts, Play with me --
                changes at all. The right framing depends on the frame's shape,
                and only the caller knows that.
              */}
              <ClipMedia
                clip={clip}
                autoPlay
                active={i === active}
                className="h-full w-full object-cover object-[center_12%]"
              />
            </div>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 p-5">
              <h2 className="max-w-[16rem] text-2xl font-black leading-tight tracking-tight text-white drop-shadow">
                {clip.characterName}
              </h2>
              <Link
                to={`/characters/${clip.characterId}`}
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 text-sm font-bold text-zinc-950 shadow-lg transition-transform active:scale-95"
              >
                Say hello <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        ))}
      </div>

      {clips.length > 1 && (
        <div className="absolute right-4 top-4 flex gap-1.5">
          {clips.map((clip, i) => (
            <button
              key={clip.id}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === active}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === active ? 'w-6 bg-white' : 'w-2 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
