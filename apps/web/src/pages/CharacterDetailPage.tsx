import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { CharacterVisualIdentityResponse, PublicCharacter } from '@over18/shared';
import { API_URL, ApiRequestError, charactersApi, conversationsApi, type PublicClip } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { apparentAge, characterHeaderItems, type CharacterMediaItem } from '../lib/media';
import { adultAgeFromBand } from '../lib/lobbyContent';
import { mockRelationship } from '../lib/relationship';
import ProfileHero from '../components/profile/ProfileHero';
import ProfileActions from '../components/profile/ProfileActions';
import RelationshipTracker from '../components/profile/RelationshipTracker';
import ProfileTabs, { type ProfileTab } from '../components/profile/ProfileTabs';
import AboutTab from '../components/profile/AboutTab';
import PostsTab from '../components/profile/PostsTab';
import MediaViewer from '../components/MediaViewer';
import PremiumGate from '../components/PremiumGate';

type VisualState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: CharacterVisualIdentityResponse };

type ProfileState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; character: PublicCharacter };

/**
 * Persona Profile — UI v2 (US-29).
 *
 * A media-led adult-companion profile: a paginated hero player over the
 * character's REAL video clips, a mock relationship tracker, primary actions
 * (Premium / Chat / Call), and About / Posts tabs — Posts carrying a content
 * paywall. Data loading (character + public Visual Identity), the Start-chat
 * flow, and the profile states are all preserved from the prior implementation;
 * only the presentation changed. Media flows through the existing provider-
 * agnostic resolver and the US-19 MediaViewer / PremiumGate.
 */
export default function CharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { status: authStatus } = useAuth();
  const [state, setState] = useState<ProfileState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [visual, setVisual] = useState<VisualState>({ status: 'loading' });
  const [tab, setTab] = useState<ProfileTab>('about');
  const [viewer, setViewer] = useState<{ items: CharacterMediaItem[]; index: number } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  /**
   * Her real content collection, for the Posts tab.
   *
   * A separate request from the visual identity on purpose: identity is who she
   * is, this is what she has posted, and the tab must never substitute one for
   * the other. Failure degrades to an empty collection rather than to her
   * profile image — showing nothing is honest, showing her portrait is not.
   */
  const [clips, setClips] = useState<PublicClip[]>([]);

  const startChat = useCallback(
    async (character: PublicCharacter) => {
      if (authStatus !== 'authenticated') {
        navigate('/login', { state: { from: location.pathname } });
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const conversation = await conversationsApi.start(character.id);
        navigate(`/chat/${conversation.id}`);
      } catch {
        setStartError("Couldn't start the conversation. Please try again.");
        setStarting(false);
      }
    },
    [authStatus, navigate, location.pathname],
  );

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setState({ status: 'loading' });
    charactersApi
      .get(characterId)
      .then((character) => !cancelled && setState({ status: 'ready', character }))
      .catch((err) => {
        if (cancelled) return;
        setState(
          err instanceof ApiRequestError && err.status === 404
            ? { status: 'not-found' }
            : { status: 'error' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setVisual({ status: 'loading' });
    charactersApi
      .visualIdentity(characterId)
      .then((data) => !cancelled && setVisual({ status: 'ready', data }))
      .catch(() => !cancelled && setVisual({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  useEffect(() => {
    if (!characterId) return;
    let cancelled = false;
    setClips([]);
    charactersApi
      .clips(characterId)
      .then((res) => !cancelled && setClips(res.clips))
      .catch(() => !cancelled && setClips([]));
    return () => {
      cancelled = true;
    };
  }, [characterId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const goBack = useCallback(() => navigate('/characters'), [navigate]);

  const backLink = (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex w-fit items-center gap-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
    >
      <span aria-hidden>←</span> Back to lobby
    </button>
  );

  if (state.status === 'loading') {
    return (
      <section className="flex flex-col gap-4 px-4 pb-8 pt-6" aria-busy>
        {backLink}
        <div className="animate-pulse overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
          <div className="aspect-[4/5] w-full bg-zinc-800" />
        </div>
        <div className="h-12 animate-pulse rounded-2xl bg-zinc-900" />
      </section>
    );
  }

  if (state.status === 'not-found' || state.status === 'error') {
    const notFound = state.status === 'not-found';
    return (
      <section className="flex flex-col gap-4 px-4 pb-8 pt-6">
        {backLink}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
          <span aria-hidden className="text-3xl">
            {notFound ? '☾' : '⚠'}
          </span>
          <div>
            <p className="font-medium">
              {notFound ? "This companion isn't available" : "Couldn't load this profile"}
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              {notFound
                ? 'They may have been retired. Plenty of others would love to meet you.'
                : 'Check your connection and try again.'}
            </p>
          </div>
          {notFound ? (
            <Link
              to="/characters"
              className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Browse companions
            </Link>
          ) : (
            <button
              type="button"
              onClick={retry}
              className="rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  const { character } = state;
  const visualData = visual.status === 'ready' ? visual.data : null;
  const attributes = visualData?.identity?.attributes ?? [];
  /**
   * The header deck: her own videos.
   *
   * `clips` is the collection the Posts tab already fetches — reference-free
   * and approval-gated by the server. It used to be read only by that tab,
   * which is why the header showed a still for every CMS-created character
   * while her videos sat two tabs away. One function decides the whole deck;
   * see `characterHeaderItems` for the precedence and the fallback.
   */
  const heroItems: CharacterMediaItem[] = characterHeaderItems(character, clips, visualData);
  /**
   * The viewer items for the Posts tab — her posts, in the order shown.
   *
   * Previously the tab handed the viewer `heroItems`, so tapping the third post
   * opened whatever the hero deck had at index 2. Indexes now address the same
   * list the grid rendered.
   */
  const postItems: CharacterMediaItem[] = clips.map((clip) => ({
    id: clip.id,
    media:
      clip.mediaType === 'video'
        ? { kind: 'video', src: `${API_URL}${clip.url}` }
        : { kind: 'image', src: `${API_URL}${clip.url}` },
    premium: false,
  }));
  const age = adultAgeFromBand(apparentAge(visualData));
  const first = heroItems[0]!.media;
  const avatarPoster =
    first.kind === 'video' ? first.poster : first.kind === 'image' ? first.src : character.profileImage ?? undefined;
  const relationship = mockRelationship(character);

  return (
    <div className="flex flex-col pb-10">
      <ProfileHero
        items={heroItems}
        name={character.displayName}
        age={age}
        avatarPoster={avatarPoster}
        onBack={goBack}
        onOpen={(index) => setViewer({ items: heroItems, index })}
      />

      <div className="flex flex-col gap-4 px-4 pt-4">
        {startError && (
          <p role="alert" className="rounded-lg border border-red-900 bg-red-950/90 px-3 py-2 text-center text-sm text-red-300">
            {startError}
          </p>
        )}

        <ProfileActions
          onUpgrade={() => setGateOpen(true)}
          onChat={() => startChat(character)}
          onCall={() => setGateOpen(true)}
          chatting={starting}
        />

        <RelationshipTracker state={relationship} />

        <ProfileTabs active={tab} onChange={setTab} postsCount={clips.length} />

        {tab === 'about' ? (
          <AboutTab character={character} attributes={attributes} />
        ) : (
          <PostsTab
            clips={clips}
            onOpenClip={(index) => setViewer({ items: postItems, index })}
          />
        )}
      </div>

      {viewer && (
        <MediaViewer
          items={viewer.items}
          startIndex={viewer.index}
          label={character.displayName}
          onClose={() => setViewer(null)}
        />
      )}
      {gateOpen && <PremiumGate name={character.displayName} onClose={() => setGateOpen(false)} />}
    </div>
  );
}
