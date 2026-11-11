# Design artifacts

Design material for tracetap. Behaviour specs live in
[`../superpowers/specs/`](../superpowers/specs/); this folder holds visual and
product-direction work.

## `tracetap-mockups.dc.html`

A design canvas from 2026-10-25 ("TraceTap — what I'm designing for"). It frames
the dashboard around six things a person comes to do, in the order they happen:

1. **Trace the flow**: turns, steps, calls and hooks in the order they happened.
2. **See in and out**: what was sent and what came back at every boundary.
3. **Understand hooks**: when, why and how they fired, and what they set off.
4. **Find the bloat**: what fills the window, what is carried for nothing, what
   is declared and never used.
5. **Cut overhead**: fewer turns, a smaller toolset, less re-sent context.
6. **Align spend**: model and thinking level matched to the step.

It then shows design options judged against those six, and records the
decisions taken. The data in it is illustrative, not from real sessions.

**It does not render on its own.** It loads `./support.js` and a `_ds/`
design-system bundle that are not in the repo, so opening it directly shows
unstyled markup. It is kept as a record of intent.

### Where the specs pick it up

| Job | Spec |
| --- | --- |
| Understand hooks, see in and out | [Session debug mode](../superpowers/specs/2026-11-02-session-debug-mode-design.md): full wire and hook capture for one session |
| Find the bloat, trace the flow for every session | [Claude Code transcript import](../superpowers/specs/2026-11-11-claude-transcript-import-design.md): X-Ray, compaction "why" and cost for sessions that were never wrapped |
| Cut overhead, align spend | Not yet specified. The dead-tool tax view and Analytics cover part of it today. |
