# CLAUDE.md

Context for Claude Code working on this repository.

## What this is

A patient queue/token system for a single-doctor clinic in India. It runs on one
Windows PC in the clinic. The receptionist hands out numbers, the doctor rotates
between examination rooms, and a TV in the waiting area shows who goes where.

Read `README.md` for the user-facing description. This file covers the things
that are not obvious from the code and that are expensive to get wrong.

## Run it

```bash
node server.js          # http://localhost:8080
node test.js            # 40 assertions, ~2 seconds, no framework
```

There is no build step, no install step, and no `node_modules`. If `npm install`
ever becomes necessary, something has gone wrong.

## Hard constraints

These come from the deployment environment, not from taste. Please do not
relax one without saying so explicitly.

1. **Zero runtime dependencies.** The clinic's technician installs Node.js once
   and copies a folder. No express, no sqlite, no bundler, no framework. The
   standard library is enough and has been so far.
2. **Works with no internet, forever.** No CDN links, no Google Fonts, no
   telemetry, no update checks. Fonts are restricted to what ships with Windows
   (`Segoe UI`, `Nirmala UI` for Devanagari, `Segoe UI Black` for the big numerals).
3. **No build step.** `public/*.html` are served raw so a local technician can
   fix a typo in Notepad. Keep the JavaScript plain and readable; no JSX, no
   TypeScript, no modules that need transpiling.
4. **No browser storage.** `localStorage`/`sessionStorage` must not hold queue
   state. Three screens have to agree with each other, so the server is the only
   source of truth. Browsers hold render state only.
5. **The state file is the product.** Anything that would make the system lose
   or rewind the token counter is a serious bug, not a cosmetic one.

## Invariants worth protecting

**Atomic, flushed writes.** `saveAtomic()` does write → `fsync` → rename, and
keeps one `.bak` generation. This is what makes a power cut survivable. Replacing
it with a plain `fs.writeFileSync` would look like a harmless simplification and
would quietly destroy the main guarantee of the system. `loadJson()` falls back
to `.bak` for the same reason.

**Every mutation persists immediately.** There is no debounce or batching. The
clinic loses power without warning; an in-memory change that has not reached the
disk is a change that did not happen.

**`orderedWaiting()` and `advanceCycle()` must agree.** `orderedWaiting()`
projects the whole future calling order (the waiting-room TV shows it), while
`advanceCycle()` moves the real cursor when someone is actually called. They
implement the same rule and must be changed together, or the screen will promise
an order the system does not follow.

The rule for the `mix` policy: walk a repeating pattern such as `[A,A,W]`. If the
slot's stream is empty, serve the other stream **without advancing the position**,
so a quiet hour with no appointments does not later produce a burst of `A`
numbers. `testPatternResumes` in `test.js` pins this down.

**Urgent is outside the fair-share arrangement.** Urgent tokens always sort to
the front and never consume a pattern slot.

**`config.rooms` and `state.rooms` are deliberately different things.**
Config holds the definition (name, Hindi name, colour); state holds only
occupancy and the VIP hold (`{id, tokenId, reserved}`). They are reconciled by
id on load and whenever settings are saved. Do not merge them.

**Old state files must keep loading.** `loadTodayState()` has guards like
`if (s.lastAppt == null)`. A clinic may upgrade mid-week with a live file on
disk. Adding a field means adding a guard.

**Local time, deliberately.** `todayKey()` uses local time because the clinic day
boundary is local midnight. Do not "fix" it to UTC.

**Undo is in-memory only.** After a restart there is nothing to undo, and that is
correct — undoing across a power cut would confuse the receptionist more than it
would help. Not a missing feature.

## Interface constraints

The receptionist is assumed to be digitally illiterate. This drives real
decisions, not just styling.

- Her entire job is **three buttons to issue a number** (walk-in / booked /
  urgent) and **one ✓ Checked button per room**. Room assignment is automatic.
- **No typing in the issuing flow.** No name, no phone, no age. This was an
  explicit product decision. A feature that adds a required field to that flow
  needs a conscious conversation first.
- The letter prefix (`A`, `E`) is the primary signal for the token type; colour
  is a secondary cue. Do not make colour load-bearing on its own — it has to work
  on a black-and-white slip and for colour-blind patients.
- Room colours exist so a patient who cannot read "Room 2" can match a coloured
  paper on the door. That is why colours are configurable per room.
- Error text says what to do, not what broke: "check the black window is still
  open", not "fetch failed".

## Layout

```
server.js        the whole backend: state, queue logic, HTTP, persistence
qr.js            console QR encoder for the doctor's phone URL (zero deps, ECC L, v1-5)
test.js          regression suite
public/
  common.js      polling, API calls, chime, speech, shared render helpers
  app.css        shared styles and the colour tokens
  reception.html the receptionist's screen
  display.html   the waiting-room TV
  doctor.html    the doctor's phone
  settings.html  PIN-protected configuration
docs/
  ARCHITECTURE.md  how the system works
  DESIGN.md        why it is built this way - update when a decision here changes
data/            runtime only, never committed
  config.json
  state-YYYY-MM-DD.json
  archive/YYYY-MM-DD.csv
*.bat            Windows launchers - keep CRLF line endings (.gitattributes enforces)
```

## Conventions

- Two-space indent, semicolons, single quotes, `'use strict'` in Node files.
- Comments explain *why*, not *what*. The non-obvious decisions above are already
  commented in place; keep it that way when you add to them.
- Add a test to `test.js` for any change to queue ordering, persistence, or the
  day rollover. The suite is fast on purpose so there is no excuse to skip it.
- The `.bat` files must stay CRLF. If you edit them on Linux, re-run
  `sed -i 's/$/\r/'` and check with `file *.bat`.

## Known gaps, in rough priority order

1. **Appointment slot times.** Booked patients are ordered by arrival, not by the
   time they were booked for. If appointments drift, a 10am walk-in can end up
   behind an `A` number issued at noon. The fix needs the receptionist to enter a
   time, which conflicts with the no-typing rule above — so it is a genuine
   product decision, not just an implementation task.
2. **Single doctor only.** Rooms belong to one queue. Multi-doctor means a queue
   per doctor and a way to route a patient to one.
3. **No authentication beyond the Settings PIN.** Anyone on the clinic WiFi can
   reach the reception screen. Acceptable for a small clinic on an isolated
   network; not acceptable if this is ever exposed beyond that.
4. **Polling every 1.5s.** Fine for a handful of screens on a LAN. Server-Sent
   Events would be tidier but polling reconnects more reliably after a power cut,
   which matters more here.
5. **No printed slips.** Removed deliberately — numbers are written on the OPD
   slip by hand. Re-adding means a thermal printer and a new decision.
