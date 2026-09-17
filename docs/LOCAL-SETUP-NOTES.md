# Local setup — traps worth knowing

Supplements the README. The steps themselves are in
[README.md](../README.md#local-development); the model and timeout settings are
in [PHASE2-PERSONA-HANDOFF.md](./PHASE2-PERSONA-HANDOFF.md) §4, and two code
bugs found during setup are in §5 of the same document.

What follows is the operator-level traps — things that are not bugs in the
codebase but cost real time anyway, recorded so the next person recognises the
symptom instead of re-deriving the cause.

## A misplaced `.env` fails silently, not loudly

Writing `apps/api/.env` from a shell whose working directory is already
`apps/api` produces `apps/api/apps/api/.env`. The server then starts normally
and ignores every setting in it.

The symptom this produced: chat timing out at almost exactly 30034 ms, every
time. `LLM_TIMEOUT_MS=60000` was set, but in the wrong file, so the 30-second
default was still in force. Nothing in the logs mentioned the env file.

If a setting appears to have no effect, confirm where the file actually landed
before suspecting the code:

```bash
find . -name '.env' -not -path '*/node_modules/*'
```

## A reasoning model is the wrong choice for chat latency

`grok-4.6` exceeded the default 30-second timeout and surfaced as a 502
`ai_unavailable`. `grok-4.20-0309-non-reasoning` answered the same request in
about half a second.

This is why `PERSONA_VISION_MODEL` exists separately from `LLM_MODEL`: persona
generation runs once, in the background, and can afford the slower and better
model; chat cannot. Every Grok chat model accepts image input, so no separate
vision provider is required — and `grok-2-vision-*` no longer exists, so do not
trust older model names found in documentation.

## Windows specifics

- PowerShell's execution policy blocks `npm` outright until it is changed.
- `npm ci`'s dependency-script approval prompt retained only one entry per run
  in practice. Editing `package.json` directly was faster than working through
  the prompt repeatedly.
- To find an orphaned or missing dev server, `Get-NetTCPConnection -LocalPort
  5173,3000` is more informative than checking the terminal it was started in.
