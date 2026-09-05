import { Link } from 'react-router-dom';
import type { PublicPlayWithMeCard } from '../../lib/api';
import { resolveRailMedia } from '../../lib/media';
import { adultAgeFromBand } from '../../lib/lobbyContent';
import HeroMedia from '../HeroMedia';

/**
 * A single portrait, video-first persona card for the horizontal rail.
 *
 * NO REQUEST OF ITS OWN. This card used to call `useCharacterVisual`, which
 * fetched the character's ENTIRE public visual identity — Visual DNA, canonical
 * gallery and all — for the sole purpose of reading one apparent-age band. On a
 * six-card rail that was six HTTP requests and eighteen SQL queries, issued
 * after Home had already loaded, to render six short numbers.
 *
 * The band now arrives on the card itself, from Home composition. The age
 * arithmetic below is untouched and its input is identical, so the label is the
 * same one this rail has always shown. `useCharacterVisual` is unchanged and
 * still serves Discover and the swipe card, where the whole identity is used.
 */
function PlayWithMeCard({ character }: { character: PublicPlayWithMeCard }) {
  // CLIP-ONLY. The rail shows this character's own approved video and nothing
  // else — never her canonical/profile image, never the local manifest, never a
  // placeholder.
  const media = resolveRailMedia(character);
  const age = adultAgeFromBand(character.apparentAgeBand);
  // Real App Category membership, where the old version invented tags from the
  // card's index. Same chips, same place — sourced from the CMS instead.
  const tags = character.categories.slice(0, 2);

  // NO REAL VIDEO ⇒ NO CARD. The server already drops these characters from the
  // rail; this is the second lock, so no payload change can put back a tile
  // that has nothing of hers to play.
  if (!media) return null;

  return (
    <Link
      to={`/characters/${character.id}`}
      aria-label={`Open ${character.displayName}, ${age}`}
      className="group relative block aspect-[3/4] w-40 shrink-0 snap-start overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      {/* Deferred loading: a rail mounts a card per character, and off-screen
          cards were downloading and playing before anyone swiped to them. The
          card, its dimensions and the scroll-snap geometry are unchanged. */}
      {/*
        CROP TOWARD THE HEAD, not through it.

        The card is 3:4 and every clip is portrait, so `object-cover` discards
        12-26% of the clip's height. Split evenly that took up to 12.5% off the
        TOP -- measured on the live rail, it clipped Camila's and Kiko's
        hairlines, and the reported screenshot showed the same on Indira.

        `upper` anchors at 12%, leaving ~3% off the top and the rest off the
        floor. Verified on the live rail: 25% still clipped both heads, 12%
        cleared them. The card's size, ratio, gradient, chips, lazy loading and
        link behaviour are untouched -- this changes only which part of the clip
        the existing crop keeps.
      */}
      <HeroMedia media={media} alt={character.displayName} lazy focal="upper" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online
      </span>
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-bold text-white">{character.displayName}</span>
          <span className="text-xs text-zinc-300">{age}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag.slug}
              className="rounded-full bg-white/15 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur"
            >
              {tag.name}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

/**
 * "Play with me" horizontal carousel (US-28 / v2 brief §1).
 *
 * A media-first rail of portrait persona cards with dark bottom gradients,
 * attribute chips and name/age. Native horizontal scroll-snap for smooth
 * swiping; full-bleed so cards run to the screen edge.
 *
 * The original presentation, restored. Its CONTENT is now the CMS's
 * `home.playWithMe` — the active characters the server composed — rather than
 * whatever `/api/characters` happened to return first.
 */
export default function PlayWithMeCarousel({
  characters,
}: {
  characters: PublicPlayWithMeCard[];
}) {
  if (characters.length === 0) return null;
  return (
    <section aria-label="Play with me" className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-4">
        <h3 className="text-base font-bold text-white">Play with me</h3>
        <Link to="/discover/swipe" className="text-xs font-semibold text-rose-400 hover:text-rose-300">
          Swipe mode →
        </Link>
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {characters.map((character) => (
          <PlayWithMeCard key={character.id} character={character} />
        ))}
      </div>
    </section>
  );
}
