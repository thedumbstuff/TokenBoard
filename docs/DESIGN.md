# TokenBoard design

Why the system is built the way it is. The companion document,
[ARCHITECTURE.md](ARCHITECTURE.md), describes *how* it works; this one records
the decisions and their reasons, so that a future change doesn't quietly undo
one of them.

## The situation being designed for

A single-doctor clinic in India. One Windows PC at the reception desk, a TV in
the waiting area, sometimes the doctor's own phone. The receptionist is
assumed to be digitally illiterate — she can press labelled buttons, and that
must be enough. The power fails without warning, routinely. Internet may be
absent, metered, or broken for weeks; nobody on site can debug a failed
update. The person who installs the system is a local PC technician who can
install Node.js, copy a folder, and edit a file in Notepad — and no more.

Every constraint below is this paragraph, applied.

## Non-negotiable constraints

1. **Zero runtime dependencies.** The technician installs Node.js once and
   copies a folder. There is no `npm install` to fail, no lockfile to drift,
   no supply chain to audit. The standard library has been enough.
2. **Works with no internet, forever.** No CDN, no web fonts, no telemetry, no
   update check. Fonts are what ships with Windows: Segoe UI, Nirmala UI for
   Devanagari, Segoe UI Black for the big numerals. Even the chime is
   synthesised in code so no audio file needs to exist.
3. **No build step.** The HTML is served raw. When a label is wrong, the
   technician fixes it in Notepad and presses F5. JSX, TypeScript, or a
   bundler would make the folder unserviceable on site.
4. **The server is the single source of truth.** Three screens must agree at
   all times, so browsers never hold queue state — no `localStorage`, no
   `sessionStorage`, render state only. A browser that crashes, reloads, or
   gets replaced mid-morning loses nothing.
5. **The state file is the product.** A patient holding token 47 has a promise
   from the clinic. Losing or rewinding the counter breaks a room full of
   promises at once, so persistence is engineered like it matters (below).

## Surviving the power cut

The defining failure mode. Three decisions follow from it:

**Atomic, flushed writes.** Every save goes write → `fsync` → rename, keeping
one `.bak` generation; loading falls back to the `.bak`. Replacing this with a
plain `writeFileSync` would look like a harmless simplification and would
quietly destroy the system's main guarantee. This is the single most
protected piece of code in the repository.

**Every mutation persists immediately.** No debounce, no batching, no "save on
exit". The gap between an in-memory change and its disk write is exactly the
window a power cut destroys, so the gap is kept at zero.

**Recovery is automatic and silent.** On boot the server loads today's file
(or its backup), archives any past days that never got their CSV (the PC is
usually off at midnight), and carries counters across the gap when daily
reset is off. The `.bat` launcher restarts the server in a loop and Windows
starts it on boot. Nobody at the clinic "restores from backup" — the machine
comes back and the queue is simply still there.

## The receptionist's interface

She is the busiest and least technical person in the building, so her surface
area is minimal by design:

**Three buttons and a checkmark.** Walk-in, booked, urgent — that issues
numbers. One "✓ Checked" per room — that frees rooms. Room assignment is
automatic. That is the whole job.

**No typing in the issuing flow.** No name, no phone number, no age. This was
an explicit product decision, not an omission: every required field is a queue
of impatient people growing at the desk. A feature that adds typing to this
flow needs a conscious product conversation first, not a code review.

**Errors say what to do, not what broke.** "Check the black window is still
open" — because that is the action she can actually take. "Fetch failed"
helps the developer and nobody else.

**Undo instead of confirmation dialogs.** Wrong button? Undo removes the
token. Confirmations would slow every correct press to guard against the rare
wrong one; undo costs nothing until it's needed. The undo stack is
**in-memory only, deliberately**: undoing across a power cut would rewind to
a state the receptionist no longer remembers, which confuses more than it
helps. Not a missing feature.

## How patients read the screen

**The letter prefix is the primary signal; colour is secondary.** Walk-ins get
`14`, booked patients `A3`, emergencies `E1`. The letter survives a
black-and-white slip, a photocopied OPD form, and colour-blindness. Colour is
a faster secondary cue layered on top — it must never become load-bearing on
its own.

**Room colours exist for patients who cannot read.** A coloured paper on each
door matches the coloured panel on the TV. That is why colours are
configurable per room rather than fixed by the stylesheet.

**Announcements are bilingual and digit-by-digit.** "Token number one zero
five" carries across a noisy room where "one hundred and five" does not.
Hindi, English, or both, per the clinic's setting.

## Queue fairness

**The `mix` pattern is literal, not weighted.** A 2:1 ratio produces exactly
the order A, A, W, A, A, W. A smoothed weighting algorithm would be "fairer"
on some metric, but the doctor must be able to predict the order from the two
numbers he typed into Settings — predictability *is* the fairness that matters
in a waiting room.

**An empty stream doesn't bank slots.** When it's a booked patient's turn and
none is waiting, a walk-in is served but the pattern cursor does not move. A
quiet hour must not later produce a burst of `A` numbers that looks like
queue-jumping to everyone watching the TV.

**Urgent is outside the arrangement.** Urgent tokens go to the front, always,
and never consume a pattern slot. Fairness bookkeeping has no business in an
emergency.

**The TV shows the real future.** `orderedWaiting()` projects the entire
calling order with the same rule the cursor follows, so the order on screen is
a commitment, not an estimate. This is why the projection and the cursor
(`advanceCycle`) must always be changed together.

## Simplicity as a maintenance strategy

**Polling, not push.** Screens poll every 1.5 s. Server-Sent Events would be
tidier, but polling reconnects by construction — after a power cut, a WiFi
blip, or a TV losing signal, the next poll simply succeeds. On a LAN with a
handful of screens, the cost is nothing and the version check makes repaints
free. Robust-and-dumb beats elegant-and-stateful here.

**One file per layer.** The whole backend is `server.js`; the shared client
logic is `common.js`; each screen is one HTML file. The technician can hold
the entire system in his head, and there is exactly one place anything can be.

**Local time, deliberately.** The clinic day ends at local midnight, because
that is when the clinic's day ends. UTC would "fix" a bug nobody has by
creating one everybody notices around midnight.

## Security posture

The Settings page has a PIN; nothing else is authenticated. Anyone on the
clinic WiFi can reach the reception screen. This is a considered position, not
an oversight: the system is designed for an isolated LAN in a small clinic
where physical access to the desk is the real access control. It is **not**
acceptable if the system is ever exposed beyond that network — that change
would need real authentication first. The path-traversal guard on static
files and the PIN never leaving the server are the floor, not the ceiling.

## Deliberate non-features

Recorded so they aren't "helpfully" added back:

- **No printed slips.** Numbers are written by hand on the OPD slip the
  patient already carries. A thermal printer is one more thing to jam, run
  out, and fail — re-adding it is a product decision.
- **No patient names or phone numbers** in the issuing flow (see above). The
  optional `name` field exists in the data model but no reception UI asks
  for it.
- **No accounts, no cloud, no analytics.** The clinic's data stays on the
  clinic's PC. The CSV archive is the export.

## Known gaps, in rough priority order

1. **Appointment slot times.** Booked patients are ordered by arrival, not
   booked time, so a late-issued `A` number can jump an earlier walk-in. The
   fix requires the receptionist to enter a time — which collides with the
   no-typing rule. A genuine product decision, still open.
2. **Single doctor only.** Rooms belong to one queue. Multi-doctor means a
   queue per doctor and routing between them.
3. **Auth is the PIN and nothing else** — see the security posture above.
4. **Polling** stays until something forces the issue; see above.
