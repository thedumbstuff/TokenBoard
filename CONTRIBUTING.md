# Contributing to TokenBoard

Thank you for taking an interest. This is a small project with an unusual
deployment target — one Windows PC in a clinic with no internet and unreliable
power — and most of the contribution rules follow from that.

## Getting started

```bash
node server.js     # http://localhost:8080  (no install step)
node test.js       # full regression suite, ~4 seconds
```

There is nothing to `npm install`. If your change needs a dependency, a build
step, or a newer syntax that needs transpiling, it will not be merged —
see the hard constraints below.

## Hard constraints

These come from the deployment environment. A pull request that relaxes one of
them needs to argue for it explicitly, not slip it in.

1. **Zero runtime dependencies.** The Node.js standard library only.
2. **Works offline, forever.** No CDN links, no web fonts, no telemetry.
   Fonts are limited to what ships with Windows.
3. **No build step.** `public/*.html` are served raw so a local technician can
   fix a typo in Notepad.
4. **No browser storage for queue state.** The server is the single source of
   truth; browsers hold render state only.
5. **The state file is sacred.** Anything that could lose or rewind the token
   counter — including "harmless" simplifications of `saveAtomic()` — is a
   serious bug.

The reasoning behind these is written up in [docs/DESIGN.md](docs/DESIGN.md),
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit
together. Please read both before a non-trivial change.

## Making changes

- **Add a test** to `test.js` for any change to queue ordering, persistence, or
  the day rollover. The suite is fast on purpose so there is no excuse.
- Match the existing style: two-space indent, semicolons, single quotes,
  `'use strict'` in Node files. Comments explain *why*, not *what*.
- The `.bat` files must keep CRLF line endings (`.gitattributes` enforces this;
  don't fight it).
- UI text follows two rules: error messages say what to *do*, not what broke,
  and anything the receptionist sees must work without her typing.

## Reporting problems

Open an issue. If it involves a state file that failed to load or a queue that
called people in the wrong order, please attach the `data/state-*.json` file
(it contains token numbers and timestamps, no patient names by default) and
say which settings were active — the queue policy and mix ratio in particular.
