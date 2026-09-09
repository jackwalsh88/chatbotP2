import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TILE_MEDIA_CLASS, TILE_VIDEO_PLAYBACK, tileFrameClass } from '../../lib/mediaTile';
import {
  addKeywords,
  keywordsDiffer,
  removeKeyword,
  characterReadiness,
  placementLabel,
  statusLabel,
  groupBySection,
  sectionSummary,
  assetDeletable,
  deletionConsequence,
  deleteCharacterAsset,
  SECTION_RATING,
  SECTION_FILE_ACCEPT,
  type ContentSection,
  assetActions,
  isPublished,
} from '../../admin/characterContent';
import {
  PERSONA_FIELDS,
  personaFormDiff,
  personaToForm,
} from '../../admin/characterPersona';
import {
  API_URL,
  ApiRequestError,
  adminCharactersApi,
  contentLibraryApi,
  adminDiscoveryApi,
  type AdminCharacterDetail,
  type VisualIdentityView,
  type CharacterContentAsset,
  type CharacterPersonaView,
  contentReviewApi,
} from '../../lib/api';

/**
 * US-101 — one character: persona, visual identity versions, primary references.
 *
 * Versioning is the point of this screen. Editing identity attributes NEVER
 * overwrites a version — it creates the next one — so history survives and a
 * bad change can be rolled back by re-activating an earlier version.
 *
 * Exactly one version is active, and the screen says so in words rather than
 * relying on a highlight: the active version is the one generation will use.
 *
 * Identity only. Nothing here approves or rejects generated content.
 */

/** Identity attributes the form edits. Presentation (pose, lighting, clothing)
 *  is deliberately absent — that is a generation-time concern, not identity. */
const DNA_FIELDS: ReadonlyArray<{ key: string; label: string; required?: boolean }> = [
  { key: 'apparentAgeBand', label: 'Apparent age band', required: true },
  { key: 'face', label: 'Face' },
  { key: 'eyes', label: 'Eyes' },
  { key: 'hair', label: 'Hair' },
  { key: 'skin', label: 'Skin' },
  { key: 'body', label: 'Body' },
  { key: 'distinctiveFeatures', label: 'Distinctive features' },
];

/** What an operator is told after a successful upload, per shelf. */
const NOTICE: Record<ContentSection, string> = {
  regular:
    'Uploaded to Regular. Approved — no review needed. Place it in a category or the Hero to show it publicly.',
  explicit:
    'Uploaded to Explicit. Approved — no review needed. Place it in a category or the Hero to show it publicly.',
  chat: 'Uploaded to Chat Content. She can send it in a conversation. It will never appear anywhere public.',
};

function dnaToForm(dna: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of DNA_FIELDS) {
    const value = dna?.[field.key];
    out[field.key] = typeof value === 'string' ? value : '';
  }
  return out;
}

export default function AdminCharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const [detail, setDetail] = useState<AdminCharacterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [personaOpen, setPersonaOpen] = useState(false);
  const [personaDraft, setPersonaDraft] = useState({ displayName: '', shortBio: '', personality: '', conversationStyle: '', systemPrompt: '' });
  const [interestsText, setInterestsText] = useState('');
  // Autofill state is separate from `busy`: it is a proposal, not a save, and
  // it must never make the page look like something was written to the server.
  const [autofilling, setAutofilling] = useState(false);
  const [autofilled, setAutofilled] = useState(false);

  // Phase 2 — avatar-derived persona.
  const [avatarPersona, setAvatarPersona] = useState<CharacterPersonaView | null>(null);
  const [avatarPersonaOpen, setAvatarPersonaOpen] = useState(false);
  const [avatarPersonaForm, setAvatarPersonaForm] = useState<Record<string, string>>(
    personaToForm(undefined),
  );
  const [avatarPersonaOriginalForm, setAvatarPersonaOriginalForm] = useState<Record<string, string>>(
    personaToForm(undefined),
  );
  const [avatarPersonaBusy, setAvatarPersonaBusy] = useState(false);
  const [regeneratingPersona, setRegeneratingPersona] = useState(false);
  const [avatarPersonaError, setAvatarPersonaError] = useState<string | null>(null);
  const [avatarPersonaNotice, setAvatarPersonaNotice] = useState<string | null>(null);

  const [identityOpen, setIdentityOpen] = useState(false);
  const [dnaForm, setDnaForm] = useState<Record<string, string>>(dnaToForm(undefined));
  const [identityLabel, setIdentityLabel] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);

  /** Her whole content shelf, loaded alongside the detail. */
  const [content, setContent] = useState<CharacterContentAsset[] | null>(null);

  /* ---------------- acting on her content, from here ----------------
   *
   * Every control below calls an endpoint that ALREADY EXISTS and is already
   * used by another screen — the Content Library's upload, the Discovery
   * screen's keyword editor. No new backend logic and no second copy of a
   * rule: the server stays the single authority.
   *
   * WHAT DELIBERATELY IS NOT HERE ANY MORE. Approve/Reject, "Add to category"
   * and "Add to Hero" used to be offered on every tile on this page. They are
   * gone from it — not removed from the product. Approval still lives in
   * Review, placement still lives in Merchandise and the Home composer, and
   * both screens are untouched. One decision, one owner: a clip that could be
   * approved from three screens had no obvious place to look when it went
   * wrong.
   */

  const [uploadingContent, setUploadingContent] = useState(false);
  /**
   * Which shelf the hidden file input is currently acting for.
   *
   * A ref, not state: it is set immediately before `.click()` and read in the
   * change handler, so it must be correct on the very next line rather than
   * after a re-render.
   */
  const uploadSection = useRef<ContentSection>('regular');
  const [contentNotice, setContentNotice] = useState<string | null>(null);
  const contentFileInput = useRef<HTMLInputElement>(null);

  /**
   * Deleting one content item, per tile.
   *
   * Three ids rather than three booleans, because the shelves render many
   * tiles and a shared flag would arm the confirmation, the spinner or the
   * error on all of them at once. Each piece of state names the ONE asset it
   * belongs to, so a second tile's Delete cannot inherit the first tile's
   * half-finished state.
   */
  const [deleteConfirmFor, setDeleteConfirmFor] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ assetId: string; message: string } | null>(null);

  /**
   * Releasing a clip to her Posts tab, and taking it back.
   *
   * THIS SCREEN IS THE RIGHT OWNER. Approve/Reject and Home placement were
   * deliberately removed from this page — those belong to Review and to
   * Merchandise. Publishing to POSTS is neither: it is a decision about HER
   * page, which is exactly what this shelf already owns. Uploading to Regular
   * or Explicit here already publishes; this is the same axis, made reversible
   * and visible.
   *
   * Per-asset id rather than a boolean, for the same reason Delete is: the
   * shelves render many tiles and a shared flag would spin all of them.
   */
  const [publishingId, setPublishingId] = useState<string | null>(null);

  async function handleTogglePublished(asset: CharacterContentAsset) {
    setPublishingId(asset.assetId);
    setContentNotice(null);
    try {
      const live = isPublished(asset);
      await (live
        ? contentReviewApi.unpublish(asset.assetId)
        : contentReviewApi.publish(asset.assetId));
      setContentNotice(
        live
          ? 'Taken off her Posts tab. It is still approved — nothing was rejected or deleted.'
          : 'Published to her Posts tab.',
      );
      await reloadContent();
    } catch (err) {
      setContentNotice(
        err instanceof ApiRequestError ? err.message : 'Could not change publication.',
      );
    } finally {
      setPublishingId(null);
    }
  }

  /**
   * Keyword editing, per clip.
   *
   * `keywordsFor` is the asset whose editor is open — one at a time, because
   * the operation is per-asset and two open drafts invite saving one onto the
   * other. `saved` is what the server last returned, kept so Save can be
   * disabled when nothing changed. Loaded lazily on open through the SAME
   * endpoint the Discovery screen uses; no keyword state is invented here.
   */
  const [keywordsFor, setKeywordsFor] = useState<string | null>(null);
  const [keywordDraft, setKeywordDraft] = useState<string[]>([]);
  const [keywordSaved, setKeywordSaved] = useState<string[]>([]);
  const [keywordEntry, setKeywordEntry] = useState('');
  const [keywordBusy, setKeywordBusy] = useState(false);

  const load = useCallback(() => {
    if (!characterId) return;
    setError(null);
    adminCharactersApi
      .get(characterId)
      .then((next) => {
        setDetail(next);
        setPersonaDraft({
          displayName: next.character.displayName,
          shortBio: next.character.shortBio,
          personality: next.character.personality,
          conversationStyle: next.character.conversationStyle,
          systemPrompt: next.character.systemPrompt,
        });
        setInterestsText(next.character.interests.join(', '));
        setAutofilled(false);
      })
      .then(() => adminCharactersApi.content(characterId))
      .then((res) => setContent(res.assets))
      .then(() => adminCharactersApi.getPersona(characterId))
      .then((persona) => {
        setAvatarPersona(persona);
        const form = personaToForm(persona.persona);
        setAvatarPersonaForm(form);
        setAvatarPersonaOriginalForm(form);
      })
      .catch((err) => {
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
        else setError("Couldn't load this character.");
      });
  }, [characterId]);

  useEffect(load, [load]);

  /** Reloads only the shelf — used after an action that changes one item. */
  const reloadContent = useCallback(async () => {
    if (!characterId) return;
    const res = await adminCharactersApi.content(characterId);
    setContent(res.assets);
  }, [characterId]);

  /**
   * Delete one content item, through the Content Library's own delete.
   *
   * `contentLibraryApi.remove` is the SAME call the Content Library screen
   * makes, hitting the same route and the same `deleteLibraryAsset` service.
   * This page adds a place to click it and nothing else — there is no second
   * deletion implementation, and no rule about what may be deleted lives here.
   *
   * The decision, the wording and the outcome all come from
   * `deleteCharacterAsset`, which is pure enough to test; this function owns
   * only the state the tiles render.
   */
  const handleDeleteAsset = useCallback(
    async (asset: CharacterContentAsset) => {
      setDeleteError(null);
      setContentNotice(null);
      setDeletingId(asset.assetId);
      try {
        const outcome = await deleteCharacterAsset(asset, {
          remove: contentLibraryApi.remove,
          reload: reloadContent,
        });
        if (outcome.ok) {
          // The shelf has already been re-read, so the tile is gone because the
          // server no longer returns it — not because we hid it.
          setDeleteConfirmFor(null);
          setContentNotice('Deleted. The item and its stored file are gone.');
          // A deleted item cannot keep an open keyword editor.
          if (keywordsFor === asset.assetId) setKeywordsFor(null);
          return;
        }
        setDeleteError({ assetId: asset.assetId, message: outcome.message });
        // It really was deleted; only the refresh failed. Closing the
        // confirmation stops the operator re-confirming something that is done.
        if (outcome.deleted) setDeleteConfirmFor(null);
      } finally {
        setDeletingId(null);
      }
    },
    [reloadContent, keywordsFor],
  );

  /**
   * Upload straight to this character.
   *
   * The same endpoint the Content Library posts to, with the character fixed
   * to the one whose page this is — which removes the step that made the
   * Library unusable for a new character in the first place.
   *
   * IT DIFFERS FROM THE LIBRARY IN EXACTLY TWO FIELDS, both set below: the
   * rating the shelf implies, and the SHELF ITSELF. Everything else — the
   * route, the validation, the storage, the response — is the path that
   * already existed.
   *
   * THE CLIENT NAMES A SHELF, NEVER A KIND. The server turns `section: 'chat'`
   * into `kind: 'chat'`, and that column is what keeps chat media off every
   * public surface and makes it the only pool a conversation can draw from. A
   * browser that could set it could publish its own private media.
   */
  async function uploadContent(file: File | undefined, section: ContentSection) {
    if (!file || !characterId || uploadingContent) return;
    setUploadingContent(true);
    setActionError(null);
    setContentNotice(null);
    try {
      /**
       * Character content skips Review and lands approved.
       *
       * `SECTION_RATING` is the single place the section-to-rating mapping
       * lives, and `section` is the single thing that tells the server which
       * shelf this is — so a Regular upload cannot arrive as Explicit or as
       * Chat, and the reverse is equally impossible.
       *
       * The Content Library's upload calls this same function WITHOUT a
       * section and still queues for Review, unchanged.
       */
      await contentLibraryApi.upload(file, characterId, {
        contentRating: SECTION_RATING[section],
        section,
      });
      await reloadContent();
      setContentNotice(NOTICE[section]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploadingContent(false);
      if (contentFileInput.current) contentFileInput.current.value = '';
    }
  }

  /* ---------------- keywords, per clip ---------------- */

  /** Opens one item's keyword editor, reading its CURRENT set from the server. */
  async function openKeywords(assetId: string) {
    if (keywordsFor === assetId) {
      setKeywordsFor(null);
      return;
    }
    setKeywordsFor(assetId);
    setKeywordEntry('');
    setKeywordDraft([]);
    setKeywordSaved([]);
    setKeywordBusy(true);
    setActionError(null);
    try {
      const res = await adminDiscoveryApi.assetKeywords(assetId);
      const keys = res.keywords.map((k) => k.key);
      setKeywordSaved(keys);
      setKeywordDraft(keys);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't load this clip's keywords.");
      setKeywordsFor(null);
    } finally {
      setKeywordBusy(false);
    }
  }

  /**
   * Saves the whole set for ONE asset.
   *
   * The endpoint replaces the set, which is what makes add, remove and edit the
   * same call. It is scoped to this asset id, so nothing another clip carries
   * can be affected by it.
   */
  async function saveKeywords(assetId: string) {
    if (keywordBusy) return;
    setKeywordBusy(true);
    setActionError(null);
    setContentNotice(null);
    try {
      const res = await adminDiscoveryApi.setAssetKeywords(assetId, keywordDraft);
      const keys = res.keywords.map((k) => k.key);
      setKeywordSaved(keys);
      setKeywordDraft(keys);
      setContentNotice(
        keys.length === 0
          ? 'Keywords cleared for this clip.'
          : `Keywords saved for this clip: ${keys.join(', ')}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't save these keywords.");
    } finally {
      setKeywordBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>, failure: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Asks the server to PROPOSE a persona. Nothing is saved: the result lands in
   * the open editor for the operator to change or discard, and only "Save
   * persona" writes it. Running it again simply proposes a different one.
   */
  async function handleAutofill(characterId: string) {
    if (autofilling) return;
    setAutofilling(true);
    setActionError(null);
    try {
      const { draft } = await adminCharactersApi.autofill(characterId);
      setPersonaDraft({
        displayName: draft.displayName,
        shortBio: draft.shortBio,
        personality: draft.personality,
        conversationStyle: draft.conversationStyle,
        systemPrompt: draft.systemPrompt,
      });
      setInterestsText(draft.interests.join(', '));
      setPersonaOpen(true);
      setAutofilled(true);
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : "Couldn't write a profile just now.",
      );
    } finally {
      setAutofilling(false);
    }
  }

  /**
   * Saves ONLY the fields the admin actually changed in this session — see
   * personaFormDiff's own note on why that matters (it's what keeps
   * editedFields accurate, so regeneration knows exactly what to protect).
   */
  async function handleSaveAvatarPersona(characterId: string) {
    if (avatarPersonaBusy) return;
    const edits = personaFormDiff(avatarPersonaOriginalForm, avatarPersonaForm);
    if (Object.keys(edits).length === 0) {
      setAvatarPersonaOpen(false);
      return;
    }
    setAvatarPersonaBusy(true);
    setAvatarPersonaError(null);
    setAvatarPersonaNotice(null);
    try {
      const updated = await adminCharactersApi.savePersona(characterId, edits);
      setAvatarPersona(updated);
      const form = personaToForm(updated.persona);
      setAvatarPersonaForm(form);
      setAvatarPersonaOriginalForm(form);
      setAvatarPersonaOpen(false);
      setAvatarPersonaNotice('Persona saved.');
    } catch (err) {
      setAvatarPersonaError(
        err instanceof ApiRequestError ? err.message : "Couldn't save her persona.",
      );
    } finally {
      setAvatarPersonaBusy(false);
    }
  }

  /**
   * Re-analyses her current primary reference image. Writes immediately —
   * unlike Autofill, there is no draft step, because the protection here is
   * structural: regenerateCharacterPersona never overwrites a field already
   * in editedFields, so nothing hand-written can be lost by running this.
   */
  async function handleRegenerateAvatarPersona(characterId: string) {
    if (regeneratingPersona) return;
    setRegeneratingPersona(true);
    setAvatarPersonaError(null);
    setAvatarPersonaNotice(null);
    try {
      const updated = await adminCharactersApi.regeneratePersona(characterId);
      setAvatarPersona(updated);
      const form = personaToForm(updated.persona);
      setAvatarPersonaForm(form);
      setAvatarPersonaOriginalForm(form);
      setAvatarPersonaNotice(
        updated.editedFields.length > 0
          ? `Persona regenerated. ${updated.editedFields.length} hand-edited field${
              updated.editedFields.length === 1 ? '' : 's'
            } kept as-is.`
          : 'Persona regenerated.',
      );
    } catch (err) {
      setAvatarPersonaError(
        err instanceof ApiRequestError ? err.message : "Couldn't regenerate her persona.",
      );
    } finally {
      setRegeneratingPersona(false);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p className="text-sm text-zinc-300">Character not found</p>
        <Link to="/admin/characters" className="mt-3 inline-block text-sm text-rose-400 underline">
          Back to characters
        </Link>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p role="alert" className="text-sm text-red-300">{error}</p>
        <button type="button" onClick={load} className="mt-3 text-sm text-rose-400 underline">
          Retry
        </button>
      </div>
    );
  }
  if (!detail) return <p className="px-6 py-8 text-sm text-zinc-500">Loading…</p>;

  const { character, identities, activeIdentity, primaryReferences } = detail;

  /**
   * Her content, split once per render rather than once per section.
   *
   * `groupBySection` accounts for EVERY asset — the two video shelves plus an
   * `excluded` bucket — so the three lists below are exhaustive by
   * construction and no row can fall between them.
   */
  const shelves = groupBySection(content ?? []);

  const seedFrom = (identity: VisualIdentityView | null) => {
    setDnaForm(dnaToForm(identity?.visualDna));
    setIdentityLabel('');
    setIdentityOpen(true);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <nav className="mb-4 text-xs text-zinc-500">
        <Link to="/admin/characters" className="hover:text-zinc-300">
          Characters
        </Link>{' '}
        / {character.displayName}
      </nav>

      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">{character.displayName}</h1>
          <p className="mt-1 text-sm text-zinc-500">/{character.name}</p>
        </div>
        {/* Publishing is deliberately explicit. A quick-created character is
            INACTIVE — she has no persona yet — so nothing half-written reaches
            real users until someone says so. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              character.status === 'active' ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {character.status === 'active' ? 'Live' : 'Not live'}
          </span>
          <button
            type="button"
            disabled={busy || (character.status !== 'active' && !character.profileComplete)}
            onClick={() =>
              run(
                () =>
                  adminCharactersApi.update(character.id, {
                    status: character.status === 'active' ? 'inactive' : 'active',
                  }),
                "Couldn't change whether she is live.",
              )
            }
            className="text-xs text-rose-400 hover:text-rose-300 disabled:cursor-not-allowed disabled:text-zinc-600"
          >
            {character.status === 'active' ? 'Take offline' : 'Publish'}
          </button>
          {character.status !== 'active' && !character.profileComplete && (
            <span className="text-[10px] text-zinc-500">Write her profile first</span>
          )}
        </div>
      </header>

      {!characterReadiness(character).live && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <p className="text-sm font-medium text-amber-200">
            {characterReadiness(character).headline}
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            {characterReadiness(character).nextStep}
          </p>
          <p className="mt-1.5 text-xs text-zinc-400">
            You can upload and manage her content now — publishing is only about who can see her.
          </p>
        </div>
      )}

      {actionError && (
        <p role="alert" className="mb-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {actionError}
        </p>
      )}

      {/* ---------------- Persona ---------------- */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Persona</h2>
          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={autofilling}
              onClick={() => void handleAutofill(character.id)}
              className="text-sm text-rose-400 hover:text-rose-300 disabled:opacity-50"
            >
              {autofilling ? 'Writing…' : character.profileComplete ? 'Autofill again' : 'Autofill'}
            </button>
            <button
              type="button"
              onClick={() => setPersonaOpen((o) => !o)}
              className="text-sm text-rose-400 hover:text-rose-300"
            >
              {personaOpen ? 'Cancel' : 'Edit'}
            </button>
          </div>
        </div>

        {!character.profileComplete && !personaOpen && (
          <p className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            Her profile is not written yet
            {character.missingProfileFields.length > 0 &&
              ` (${character.missingProfileFields.length} field${
                character.missingProfileFields.length === 1 ? '' : 's'
              } empty)`}
            . Write it yourself, or use Autofill and edit what it suggests.
          </p>
        )}

        {autofilled && personaOpen && (
          <p className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
            This is a suggestion — nothing has been saved. Edit anything you like, then press Save
            persona. Autofill again for a different take.
          </p>
        )}

        {personaOpen ? (
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            {(
              [
                ['displayName', 'Display name'],
                ['shortBio', 'Short bio'],
                ['personality', 'Personality'],
                ['conversationStyle', 'Conversation style'],
                ['systemPrompt', 'System prompt'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
                <textarea
                  rows={key === 'displayName' ? 1 : 3}
                  value={personaDraft[key]}
                  onChange={(e) => setPersonaDraft({ ...personaDraft, [key]: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Interests
              </span>
              <input
                type="text"
                value={interestsText}
                onChange={(e) => setInterestsText(e.target.value)}
                placeholder="astronomy, jazz"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
              <span className="mt-1 block text-xs text-zinc-500">Comma separated.</span>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await adminCharactersApi.update(character.id, {
                    ...personaDraft,
                    interests: interestsText
                      .split(',')
                      .map((i) => i.trim())
                      .filter(Boolean),
                  });
                  setPersonaOpen(false);
                  setAutofilled(false);
                }, "Couldn't save the character.")
              }
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
            >
              Save persona
            </button>
          </div>
        ) : (
          <dl className="grid gap-3 rounded-lg border border-zinc-800 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Short bio</dt>
              <dd className="text-zinc-300">{character.shortBio || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Personality</dt>
              <dd className="text-zinc-300">{character.personality || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Conversation style</dt>
              <dd className="text-zinc-300">{character.conversationStyle || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Interests</dt>
              <dd className="text-zinc-300">{character.interests.join(', ') || '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* ---------------- Avatar-derived persona (Phase 2) ---------------- */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Avatar-derived persona
          </h2>
          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={regeneratingPersona || primaryReferences.length === 0}
              title={
                primaryReferences.length === 0
                  ? 'Add a primary reference image first'
                  : undefined
              }
              onClick={() => void handleRegenerateAvatarPersona(character.id)}
              className="text-sm text-rose-400 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {regeneratingPersona ? 'Analysing…' : 'Regenerate from avatar'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!avatarPersonaOpen) {
                  setAvatarPersonaForm(avatarPersonaOriginalForm);
                }
                setAvatarPersonaOpen((o) => !o);
              }}
              className="text-sm text-rose-400 hover:text-rose-300"
            >
              {avatarPersonaOpen ? 'Cancel' : 'Edit'}
            </button>
          </div>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-zinc-500">
          A richer identity generated from her primary reference image — additional facts and a
          voice clause rendered into WHO SHE IS / HER VOICE alongside her profile above, never
          replacing it. Fields you edit here are protected: regenerating never overwrites them.
        </p>

        {primaryReferences.length === 0 && (
          <p className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            No primary reference image yet — add one below before regenerating.
          </p>
        )}

        {avatarPersona?.generatedAt && (
          <p className="mb-3 text-xs text-zinc-500">
            Last generated {new Date(avatarPersona.generatedAt).toLocaleString()}.
          </p>
        )}

        {avatarPersonaError && (
          <p role="alert" className="mb-3 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">
            {avatarPersonaError}
          </p>
        )}
        {avatarPersonaNotice && !avatarPersonaOpen && (
          <p role="status" aria-live="polite" className="mb-3 rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            {avatarPersonaNotice}
          </p>
        )}

        {avatarPersonaOpen ? (
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            {PERSONA_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  {field.label}
                  {avatarPersona?.editedFields.includes(field.key) && (
                    <span className="ml-1.5 rounded bg-zinc-800 px-1 py-0.5 text-[9px] normal-case tracking-normal text-zinc-400">
                      edited
                    </span>
                  )}
                </span>
                <input
                  type={field.kind === 'number' ? 'number' : 'text'}
                  value={avatarPersonaForm[field.key] ?? ''}
                  onChange={(e) =>
                    setAvatarPersonaForm({ ...avatarPersonaForm, [field.key]: e.target.value })
                  }
                  placeholder={field.kind === 'list' ? 'comma, separated, list' : ''}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            {avatarPersona?.persona.sourceSummary && (
              <p className="text-xs text-zinc-500">
                Source summary (generator-only, never sent to chat):{' '}
                {avatarPersona.persona.sourceSummary}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={avatarPersonaBusy}
                onClick={() => void handleSaveAvatarPersona(character.id)}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {avatarPersonaBusy ? 'Saving…' : 'Save persona fields'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAvatarPersonaForm(avatarPersonaOriginalForm);
                  setAvatarPersonaOpen(false);
                }}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <dl className="grid gap-3 rounded-lg border border-zinc-800 p-4 text-sm sm:grid-cols-2">
            {PERSONA_FIELDS.filter((field) => (avatarPersonaForm[field.key] ?? '').length > 0).length ===
            0 ? (
              <div className="text-zinc-500 sm:col-span-2">
                No persona generated yet.{' '}
                {primaryReferences.length > 0
                  ? 'Use Regenerate from avatar, or Edit to write one by hand.'
                  : 'Add a primary reference image, then use Regenerate from avatar.'}
              </div>
            ) : (
              PERSONA_FIELDS.filter((field) => (avatarPersonaForm[field.key] ?? '').length > 0).map(
                (field) => (
                  <div key={field.key}>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">
                      {field.label}
                      {avatarPersona?.editedFields.includes(field.key) && (
                        <span className="ml-1.5 rounded bg-zinc-800 px-1 py-0.5 text-[9px] normal-case tracking-normal text-zinc-400">
                          edited
                        </span>
                      )}
                    </dt>
                    <dd className="text-zinc-300">{avatarPersonaForm[field.key]}</dd>
                  </div>
                ),
              )
            )}
          </dl>
        )}
      </section>

      {/* ---------------- Visual identity ---------------- */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Visual identity
          </h2>
          <button
            type="button"
            onClick={() => seedFrom(activeIdentity)}
            className="text-sm text-rose-400 hover:text-rose-300"
          >
            {identities.length === 0 ? 'Create v1' : 'New version'}
          </button>
        </div>

        <p className="mb-3 text-xs text-zinc-500">
          {activeIdentity
            ? `Version ${activeIdentity.version} is active — this is the identity generation uses.`
            : identities.length === 0
              ? 'No visual identity yet. Create v1 to describe how she looks.'
              : 'No version is active yet. Activate one before generating anything.'}{' '}
          Editing never overwrites history: a change creates a new version.
        </p>

        {identityOpen && (
          <div className="mb-4 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-medium text-zinc-200">
              New version{identities.length > 0 ? ` (v${identities[0]!.version + 1})` : ' (v1)'}
            </h3>
            {DNA_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  {field.label}
                  {field.required && <span className="text-rose-400"> *</span>}
                </span>
                <input
                  type="text"
                  value={dnaForm[field.key] ?? ''}
                  onChange={(e) => setDnaForm({ ...dnaForm, [field.key]: e.target.value })}
                  placeholder={field.required ? 'adult' : ''}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Label (optional)
              </span>
              <input
                type="text"
                value={identityLabel}
                onChange={(e) => setIdentityLabel(e.target.value)}
                placeholder="softer look"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              />
            </label>
            <p className="text-xs text-zinc-500">
              Apparent age band must describe an adult; anything else is rejected.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const visualDna: Record<string, string> = {};
                    for (const [key, value] of Object.entries(dnaForm)) {
                      if (value.trim()) visualDna[key] = value.trim();
                    }
                    await adminCharactersApi.createIdentity(character.id, {
                      visualDna,
                      label: identityLabel.trim() || undefined,
                    });
                    setIdentityOpen(false);
                  }, "Couldn't create the version.")
                }
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                Create version
              </button>
              <button
                type="button"
                onClick={() => setIdentityOpen(false)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {identities.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
            No versions yet.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {identities.map((identity) => (
              <li key={identity.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100">
                    v{identity.version}{' '}
                    <span className="text-zinc-500">{identity.label ?? 'unlabelled'}</span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    {identity.isActive
                      ? 'Active — used by all generation'
                      : identity.status === 'draft'
                        ? 'Draft — not used yet'
                        : 'Retired — kept for history'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {identity.isActive ? (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                      Active
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => adminCharactersApi.activateIdentity(identity.id),
                          "Couldn't activate that version.",
                        )
                      }
                      className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => seedFrom(identity)}
                    className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-600"
                  >
                    Duplicate
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Content: Regular and Explicit ---------------- */}
      {/*
          Two video shelves, split by the `content_rating` the column has always
          carried: `sfw` is Regular, `explicit` is Explicit. Nothing new is
          stored for this and no migration was needed.

          UPLOADS HERE SKIP REVIEW and land approved, because an operator
          uploading a clip to a character has already made the editorial call. A
          second queue to re-make it was ceremony. Review itself is untouched
          and still serves everything that reaches it by any other path.

          NO "ADD TO CATEGORY" AND NO "ADD TO HERO" on these shelves. Placement
          belongs to Merchandise and the Home composer; offering it here as well
          gave the same clip three different homes and no obvious owner. Where a
          clip IS placed still shows, as text.
      */}
      {(
        [
          ['regular', 'Regular', 'Everyday video for this character.', 'video'],
          ['explicit', 'Explicit', 'Adult video for this character.', 'video'],
          [
            'chat',
            'Chat Content',
            'Photos and clips she can send inside a conversation.',
            'chat',
          ],
        ] as Array<[ContentSection, string, string, 'video' | 'chat']>
      ).map(([section, heading, blurb, mode]) => {
        const items = shelves[section];
        return (
          <section key={section}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
                {heading}
              </h2>
              <div className="flex items-center gap-3">
                <p className="text-xs text-zinc-500">
                  {content === null ? 'Loading…' : sectionSummary(items, section)}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    uploadSection.current = section;
                    // Set imperatively rather than from state: `.click()` runs
                    // on the very next line, before any re-render could apply
                    // a state change, so the picker would otherwise offer the
                    // PREVIOUS shelf's file types.
                    const el = contentFileInput.current;
                    if (!el) return;
                    el.accept = SECTION_FILE_ACCEPT[section];
                    el.click();
                  }}
                  disabled={uploadingContent || busy}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600"
                >
                  {uploadingContent
                    ? 'Uploading…'
                    : mode === 'chat'
                      ? 'Upload image or video'
                      : `Upload ${heading.toLowerCase()} video`}
                </button>
              </div>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-zinc-500">
              {blurb}{' '}
              {mode === 'chat'
                ? 'Images and videos, approved the moment they upload — no review step. Chat Content is private: it is never shown in Search, Posts, Play with me, categories or the Hero, and it is the only media she can send in a chat.'
                : 'Video only, and approved the moment it uploads — no review step. Approved is not the same as public: each item below says where it appears.'}
            </p>

            {content !== null && items.length === 0 && (
              <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-8 text-center">
                <p className="text-sm text-zinc-300">
                  {mode === 'chat' ? 'No chat media yet' : `No ${heading.toLowerCase()} video yet`}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                  {mode === 'chat'
                    ? 'Use Upload image or video above. Until something is here, she sends text only.'
                    : `Use Upload ${heading.toLowerCase()} video above.`}
                </p>
              </div>
            )}

            {items.length > 0 && (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {items.map((asset) => (
                  <li
                    key={asset.assetId}
                    className="overflow-hidden rounded-lg border border-zinc-800"
                  >
                    <div className={`w-full ${tileFrameClass()}`}>
                      {/* Chat Content holds both, so the tile follows the
                          asset rather than assuming video. Regular and
                          Explicit are video-only and are unaffected. */}
                      {asset.previewUrl ? (
                        asset.mediaType === 'video' ? (
                          <video
                            src={`${API_URL}${asset.previewUrl}`}
                            {...TILE_VIDEO_PLAYBACK}
                            preload="metadata"
                            className={TILE_MEDIA_CLASS}
                          />
                        ) : (
                          <img
                            src={`${API_URL}${asset.previewUrl}`}
                            alt=""
                            loading="lazy"
                            className={TILE_MEDIA_CLASS}
                          />
                        )
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-600">
                          No file
                        </div>
                      )}
                    </div>
                    <div className="space-y-0.5 p-2">
                      <p className="truncate text-[11px] font-medium text-zinc-300">
                        {statusLabel(asset)}
                      </p>
                      <p className="truncate text-[11px] text-zinc-500">
                        {placementLabel(asset)}
                      </p>
                      {/* Approved and live are different questions now. */}
                      {asset.status === 'approved' && asset.kind === 'generated' && (
                        <p
                          className={`truncate text-[11px] ${
                            isPublished(asset) ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {isPublished(asset) ? 'On her Posts tab' : 'Not on her Posts tab'}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1 pt-1">
                        <button
                          type="button"
                          onClick={() => void openKeywords(asset.assetId)}
                          disabled={busy}
                          aria-expanded={keywordsFor === asset.assetId}
                          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                        >
                          {keywordsFor === asset.assetId ? 'Close keywords' : 'Keywords'}
                        </button>
                        {/* LIVE ON HER PAGE, or not. Approving no longer
                            publishes, so the shelf has to say which. */}
                        {(assetActions(asset).canPublish || assetActions(asset).canUnpublish) && (
                          <button
                            type="button"
                            onClick={() => void handleTogglePublished(asset)}
                            disabled={busy || publishingId !== null}
                            aria-pressed={isPublished(asset)}
                            className={`rounded border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                              isPublished(asset)
                                ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                                : 'border-zinc-700 text-zinc-200 hover:border-zinc-600'
                            }`}
                          >
                            {publishingId === asset.assetId
                              ? '…'
                              : isPublished(asset)
                                ? 'Unpublish'
                                : 'Publish to Posts'}
                          </button>
                        )}
                        {assetDeletable(asset).deletable && (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteConfirmFor(asset.assetId);
                            }}
                            disabled={busy || deletingId !== null}
                            aria-expanded={deleteConfirmFor === asset.assetId}
                            className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </div>

                      {/* Confirmation, in the tile. It names the consequences
                          that are NOT visible from the tile — the stored file,
                          where the item is placed, what a chat message that
                          already carried it will look like afterwards. */}
                      {deleteConfirmFor === asset.assetId && (
                        <div className="mt-1.5 rounded border border-red-500/30 bg-red-500/5 p-2">
                          <p className="text-[11px] leading-relaxed text-zinc-300">
                            {deletionConsequence(asset)}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmFor(null)}
                              disabled={deletingId === asset.assetId}
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteAsset(asset)}
                              disabled={deletingId === asset.assetId}
                              className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                            >
                              {deletingId === asset.assetId ? 'Deleting…' : 'Confirm delete'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* The failure stays on the tile it belongs to, and the
                          tile stays on the shelf — nothing was removed. */}
                      {deleteError?.assetId === asset.assetId && (
                        <p
                          role="alert"
                          className="mt-1.5 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11px] leading-relaxed text-red-300"
                        >
                          {deleteError.message}
                        </p>
                      )}
                  {/* One clip's keywords. Chips with an obvious remove,
                      a free-text add, and a single Save that PUTs the
                      whole set for THIS asset only. */}
                  {keywordsFor === asset.assetId && (
                    <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/60 p-2">
                      <p className="text-[11px] font-medium text-zinc-300">Keywords</p>
                      {keywordBusy && keywordDraft.length === 0 ? (
                        <p className="mt-1 text-[11px] text-zinc-500">Loading…</p>
                      ) : (
                        <>
                          <ul className="mt-1 flex flex-wrap gap-1">
                            {keywordDraft.length === 0 && (
                              <li className="text-[11px] text-zinc-500">
                                No keywords yet.
                              </li>
                            )}
                            {keywordDraft.map((keyword) => (
                              <li
                                key={keyword}
                                className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-200"
                              >
                                {keyword}
                                <button
                                  type="button"
                                  aria-label={`Remove keyword ${keyword}`}
                                  onClick={() =>
                                    setKeywordDraft((d) => removeKeyword(d, keyword))
                                  }
                                  disabled={keywordBusy}
                                  className="text-zinc-500 hover:text-red-300 disabled:opacity-50"
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <label
                              htmlFor={`keyword-entry-${asset.assetId}`}
                              className="sr-only"
                            >
                              Add a keyword
                            </label>
                            <input
                              id={`keyword-entry-${asset.assetId}`}
                              value={keywordEntry}
                              onChange={(e) => setKeywordEntry(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                setKeywordDraft((d) => addKeywords(d, keywordEntry));
                                setKeywordEntry('');
                              }}
                              placeholder="beach, bikini…"
                              disabled={keywordBusy}
                              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-100 placeholder:text-zinc-600"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setKeywordDraft((d) => addKeywords(d, keywordEntry));
                                setKeywordEntry('');
                              }}
                              disabled={keywordBusy || keywordEntry.trim() === ''}
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                            >
                              Add keyword
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveKeywords(asset.assetId)}
                              disabled={
                                keywordBusy || !keywordsDiffer(keywordSaved, keywordDraft)
                              }
                              className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                            >
                              {keywordBusy ? 'Saving…' : 'Save keywords'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {/* One hidden input serves both shelves; `uploadSection` says which one
          opened it. Video only, matching what the server will accept. */}
      <input
        ref={contentFileInput}
        type="file"
        accept={SECTION_FILE_ACCEPT.regular}
        onChange={(e) => void uploadContent(e.target.files?.[0], uploadSection.current)}
        className="hidden"
      />

      {contentNotice && (
        <p
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200"
        >
          {contentNotice}
        </p>
      )}

      {/* ---------------- Primary references ---------------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Primary references
          </h2>
          {activeIdentity && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void run(
                    () => adminCharactersApi.uploadReference(activeIdentity.id, file),
                    "Couldn't upload that reference.",
                  );
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
                className="text-sm text-rose-400 hover:text-rose-300 disabled:opacity-50"
              >
                Add reference
              </button>
            </>
          )}
        </div>

        {!activeIdentity ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
            Activate a visual identity version first — references belong to a version.
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-zinc-500">
              Attached to v{activeIdentity.version}. These are what users see and what generation
              will match against.
            </p>
            {primaryReferences.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
                No primary references yet — add one.
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {primaryReferences.map((reference) => (
                  <li key={reference.assetId} className="overflow-hidden rounded-lg border border-zinc-800">
                    <div className="relative aspect-[3/4] bg-zinc-900">
                      {reference.fileUrl &&
                        (reference.mediaType === 'video' ? (
                          <video
                            src={`${API_URL}${reference.fileUrl}`}
                            {...TILE_VIDEO_PLAYBACK}
                            preload="metadata"
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <img
                            src={`${API_URL}${reference.fileUrl}`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-contain"
                          />
                        ))}
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-emerald-400">
                        Primary
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => adminCharactersApi.removePrimary(reference.assetId),
                            "Couldn't remove that reference.",
                          )
                        }
                        className="text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
