import type { PublicCharacter, PublicVisualIdentityAttribute } from '@over18/shared';

/**
 * About tab: bio, personality/conversation style, a structured attribute grid
 * from the public Visual Identity, and interests. TEXT AND ATTRIBUTES ONLY —
 * it renders no media at all.
 *
 * ── WHAT WAS REMOVED, AND WHY ────────────────────────────────────────────────
 *
 * A "More of {displayName}" rail used to sit here, built from
 * `characterVideos` — the hard-coded four-name PoC manifest keyed on
 * `character.name`. It described itself as "the character's real additional
 * clips", and it was never that: the entries are bundled demo files under
 * `/media/<name>/`, unrelated to anything an operator published.
 *
 * IT ALSO MIS-ATTRIBUTED. The manifest is keyed on the stable slug, so a
 * character whose slug is `ember` but whose display name is "Amber" was served
 * Ember's demo clips under Amber's heading — reported from production, showing
 * tiles labelled "Off the clock" and "Late night" on Amber's page.
 *
 * IT IS NOT REPLACED WITH A SECOND POSTS GALLERY. Posts is the character's one
 * complete collection of released clips; a second rail of the same content
 * would only invite the two to disagree. About is prose and facts, Posts is
 * media, and the Hero is her current clips.
 */
export default function AboutTab({
  character,
  attributes,
}: {
  character: PublicCharacter;
  attributes: PublicVisualIdentityAttribute[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <p className="text-sm leading-relaxed text-zinc-200">{character.shortBio}</p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Personality</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.personality}</p>
      </div>

      {attributes.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Details</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
            {attributes.map((attr) => (
              <div key={attr.label} className="flex flex-col">
                <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{attr.label}</dt>
                <dd className="text-sm text-zinc-300">{attr.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {character.interests.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Interests</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {character.interests.map((interest) => (
              <li
                key={interest}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300"
              >
                {interest}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Conversation style
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">{character.conversationStyle}</p>
      </div>
    </div>
  );
}
