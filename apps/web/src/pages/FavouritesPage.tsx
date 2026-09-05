import { Link } from 'react-router-dom';
import { useFavourites } from '../hooks/useFavourites';
import { galleryCards } from '../lib/favourites';
import { resolveRailMedia } from '../lib/media';
import { adultAgeFromBand } from '../lib/lobbyContent';
import type { PublicPlayWithMeCard } from '../lib/api';
import HeroMedia from '../components/HeroMedia';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { LikeIcon, SparkleIcon } from '../components/icons';

/**
 * Favourites — the characters this user saved.
 *
 * ── WHAT A TILE IS ───────────────────────────────────────────────────────────
 *
 * One saved character and ONE real published clip of hers, resolved fresh on
 * every visit. The favourite itself stores no media at all, so if an operator
 * replaces her published clip the tile follows on the next request with nothing
 * to migrate and nothing to invalidate.
 *
 * ── WHAT IS NEVER A TILE ─────────────────────────────────────────────────────
 *
 * A saved character with no currently eligible clip. Not a placeholder, not her
 * reference portrait, not her profileImage, not a demo file, not a lettered
 * square. She stays saved — the server still returns her, her heart is still
 * filled, and she reappears here the moment eligible content does — but the
 * gallery shows nothing for her, because a tile is a claim that she has
 * something to show.
 *
 * Two locks enforce that. `galleryCards` drops any card without a real video
 * clip, and `resolveRailMedia` — the same function the Play with me rail uses —
 * can only ever return that clip or null. Neither can reach the fallback chain
 * in `resolveHeroMedia`, which remains correct and untouched for the Character
 * page.
 *
 * ── THE COUNT IS HONEST ──────────────────────────────────────────────────────
 *
 * When some favourites have no current content the page says so, rather than
 * quietly showing fewer tiles than the user knows they saved.
 */
function FavouriteTile({ character }: { character: PublicPlayWithMeCard }) {
  const media = resolveRailMedia(character);
  const age = adultAgeFromBand(character.apparentAgeBand);
  const tags = character.categories.slice(0, 2);

  // NO REAL CLIP ⇒ NO TILE. The second lock; `galleryCards` has already
  // filtered, so this can only fire if a payload change tried to put one back.
  if (!media) return null;

  return (
    <Link
      to={`/characters/${character.id}`}
      aria-label={`Open ${character.displayName}`}
      data-testid="favourite-tile"
      className="group relative block aspect-[3/4] overflow-hidden rounded-2xl border border-white/5 bg-zinc-900"
    >
      {/*
        CROP TOWARD THE HEAD, not through it.

        The same 3:4 portrait card the Play with me rail uses, so it had the
        same defect: `object-cover` discards 12-26% of a portrait clip's height
        and the CSS default split it evenly, taking up to 12.5% off the TOP --
        which is where the face is.

        `upper` anchors at 12%, the one value shared with the rail and the Home
        hero, so a character is framed the same way wherever she appears. The
        card's ratio, gradient, heart mark, name, age, chips, lazy loading and
        link are untouched: this changes only which part of the clip the
        existing crop keeps.
      */}
      <HeroMedia media={media} alt={character.displayName} lazy focal="upper" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/50 to-transparent" />
      <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-emerald-400 backdrop-blur">
        <LikeIcon width={15} height={15} />
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

export default function FavouritesPage() {
  const { status, cards, favourited, reload } = useFavourites();

  const visible = galleryCards(cards);
  // Saved, but with nothing publishable right now. Counted from the persisted
  // relationship rather than from the cards, so a character who has gone
  // inactive is included — she is still saved.
  const withoutContent = favourited.size - visible.length;

  const body = () => {
    if (status === 'loading') {
      return (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          data-testid="favourites-skeleton"
          aria-hidden
        >
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="aspect-[3/4] animate-pulse rounded-2xl bg-zinc-900" />
          ))}
        </div>
      );
    }

    if (status === 'signed-out') {
      return (
        <EmptyState
          icon={<LikeIcon className="h-6 w-6" />}
          title="Sign in to see your Favourites"
          description="Favourites are saved to your account, so they're waiting for you on every device."
          action={
            <Link
              to="/login"
              className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Sign in
            </Link>
          }
        />
      );
    }

    if (status === 'error') {
      return (
        <EmptyState
          icon={<SparkleIcon />}
          title="Couldn't load your Favourites"
          description="Something went wrong on our side. Check your connection and try again."
          action={
            <button
              type="button"
              onClick={reload}
              className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Retry
            </button>
          }
        />
      );
    }

    if (favourited.size === 0) {
      return (
        <EmptyState
          icon={<LikeIcon className="h-6 w-6" />}
          title="No Favourites yet"
          description="Swipe right on someone you like and she'll be waiting here."
          action={
            <Link
              to="/discover/swipe"
              className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Start swiping
            </Link>
          }
        />
      );
    }

    /**
     * Saved characters, none of whom currently has publishable content. An
     * empty grid with an explanation, never a grid of substitutes.
     */
    if (visible.length === 0) {
      return (
        <EmptyState
          icon={<LikeIcon className="h-6 w-6" />}
          title="Nothing new from your Favourites"
          description={`You have ${favourited.size} saved ${
            favourited.size === 1 ? 'character' : 'characters'
          }, but none of them has published content right now. They'll appear here again as soon as they do.`}
        />
      );
    }

    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {visible.map((character) => (
            <FavouriteTile key={character.id} character={character} />
          ))}
        </div>
        {withoutContent > 0 && (
          <p className="text-xs text-zinc-500">
            {withoutContent} more saved {withoutContent === 1 ? 'character has' : 'characters have'}{' '}
            no published content right now.
          </p>
        )}
      </div>
    );
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Saved"
        title="Favourites"
        subtitle="The characters you swiped right on."
      />
      {body()}
    </PageContainer>
  );
}
