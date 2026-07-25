# TokenBoard architecture

How the system works. For *why* it is built this way, read
[DESIGN.md](DESIGN.md) first — almost every structural choice here is downstream
of the constraints described there.

## The whole system at a glance

One Node.js process (`server.js`, no dependencies) owns all state and serves
four plain HTML pages. The browsers are dumb terminals: they poll, render, and
send commands. All queue state lives in the server process and is flushed to a
JSON file on every mutation.

```
                       ┌──────────────────────────────┐
                       │  server.js  (one process)     │
  reception.html ◄──┐  │                               │
  display.html   ◄──┼──┤  in-memory state ──► persist()│
  doctor.html    ◄──┼──┤        │                 │    │
  settings.html  ◄──┘  │  queue engine       saveAtomic│
       ▲               └─────────┼────────────────┼────┘
       │ poll /api/state every   │                ▼
       │ 1.5 s, POST commands    │     data/state-YYYY-MM-DD.json
       └─────────────────────────┘     data/config.json
                                       data/archive/YYYY-MM-DD.csv
```

## Layout

```
server.js        the whole backend: persistence, queue logic, HTTP
qr.js            minimal QR encoder for the startup banner (byte mode, ECC L, v1-5)
test.js          regression suite (starts real servers on throwaway data dirs)
public/
  common.js      the CQ object: polling, POST helper, chime, speech
  app.css        shared styles, colour tokens
  reception.html / display.html / doctor.html / settings.html
data/            runtime only, never committed
```

## Persistence layer

`saveAtomic(file, obj)` is the foundation everything rests on:

1. write the JSON to `file.tmp`
2. `fsync` the descriptor — force it onto the platter, past the OS cache
3. copy the current `file` to `file.bak` (one backup generation)
4. `rename(file.tmp, file)` — atomic on the same filesystem

A power cut at any point leaves either the old file, or the new file, or the
old file plus a complete `.bak`. `loadJson()` mirrors this: it tries `file`,
then `file.bak`, then a caller-supplied fallback. Corrupt JSON is logged and
skipped, never fatal.

`persist()` bumps `state.version` (the browsers' change detector) and calls
`saveAtomic`. **Every mutating operation ends with `persist()` — there is no
debounce, no batching, no dirty flag.** An in-memory change that has not
reached disk is treated as a change that did not happen.

## Configuration vs state

Two files, deliberately separate:

- **`config.json`** — the clinic's *definition*: names, rooms (name, Hindi
  name, colour), numbering prefixes, queue policy, PIN. Written only from the
  Settings page. Unknown keys from the browser are dropped against an
  allow-list; room colours are regex-validated; rooms are capped at 6 and
  re-issued sequential ids.
- **`state-YYYY-MM-DD.json`** — one file per clinic day, holding the *live
  queue*: the three counters, all tokens issued today, room occupancy
  (`{id, tokenId}` only), the mix-pattern cursor, and the pause flag.

`config.rooms` and `state.rooms` are reconciled by id on load and whenever
settings are saved: state entries for vanished rooms are dropped (their patient
is returned to `waiting`), new rooms appear empty. They must not be merged into
one structure — one is a definition, the other is occupancy.

**Old state files must keep loading.** `loadTodayState()` back-fills any field
added since the file was written (`lastAppt`, `served`, `cyclePos`, …). A
clinic may upgrade mid-week with a live file on disk; adding a state field
means adding a guard here.

## The clinic day

`todayKey()` uses **local time** — the clinic day boundary is local midnight,
not UTC. `rollDayIfNeeded()` runs at the top of every mutation and every state
read; when the date has changed it archives the old day to CSV, starts a fresh
state, and clears the undo stack.

Two numbering modes: with `resetDaily` (the default) each morning restarts
from `startNumber`; without it the counters carry over — including across days
the PC was off, by reading the most recent state file on disk.

`archivePendingDays()` runs at startup and writes a CSV for any past day that
never got one (the PC was switched off before midnight — the normal case).

## The queue engine

Three independent token series, distinguished by a letter prefix:

| kind          | label | series counter |
|---------------|-------|----------------|
| `normal`      | `14`  | `lastNormal`   |
| `appointment` | `A3`  | `lastAppt`     |
| `urgent`      | `E1`  | `lastUrgent`   |

A token's lifecycle: `waiting` → `in_room` → `done`, with a side exit to
`skipped` ("patient not here") and a way back (`recall` puts `skipped` or
`done` tokens back into `waiting`).

### Ordering: one rule, two implementations that must agree

- **`orderedWaiting()`** projects the *entire* future calling order. The
  waiting-room TV shows this list, so it is a promise made to patients.
- **`advanceCycle()`** moves the real cursor (`state.cyclePos`) one step when a
  patient is actually called.

They implement the same rule and **must be changed together**, or the screen
will promise an order the system does not follow.

The rule, per policy:

- `arrival` — urgent first, then everyone else by arrival order.
- `appointment_first` — urgent, then all booked, then all walk-ins.
- `mix` (default) — urgent first, then walk a repeating literal pattern built
  from the configured ratio, e.g. 2 booked : 1 walk-in → `[A, A, W]`.

The `mix` subtlety that `testPatternResumes` pins down: when the pattern slot's
stream is empty, the other stream is served **without advancing the cursor**.
A quiet hour with no booked patients therefore does not bank up "owed" `A`
slots that would later emerge as a burst.

**Urgent is outside the fair-share arrangement entirely**: urgent tokens sort
to the front and never consume a pattern slot (`advanceCycle` ignores them).

### Room assignment

With `autoAssign` on (default), every mutation ends by pouring
`orderedWaiting()[0]` into each free room until rooms or patients run out.
With it off, the receptionist gets a "Call next" button per empty room
(`/api/call`). Pausing the queue suspends auto-assignment; resuming fires it.

A room can be **reserved for a VIP** (`/api/reserve`): both assignment paths
skip it and the screens show it as unavailable. Reserving an occupied room is
allowed — the patient inside finishes normally and the room is then not
refilled. The flag lives in `state.rooms` so it survives a power cut, and it
resets with the rest of the state at the day rollover.

### Undo

`snapshot()` pushes a JSON string of the whole state (capped at 30) before
every mutation; `/api/undo` pops one and restores it. The stack is
**in-memory only** — after a restart there is nothing to undo, which is
correct behaviour, not a gap (see DESIGN.md). A snapshot from a previous day
is refused.

## HTTP interface

No framework; a single `http.createServer` handler with an if-chain.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/state` | full view model (see below) |
| GET  | `/api/config` | config minus the PIN |
| GET  | `/api/report.csv` | today's log as CSV (BOM-prefixed for Excel) |
| POST | `/api/token` | issue a token `{kind}` |
| POST | `/api/done` | free a room `{room}` |
| POST | `/api/call` | manual call-next into a room `{room}` |
| POST | `/api/skip` | patient not present `{id}` |
| POST | `/api/recall` | bring back a skipped/done patient `{id}` |
| POST | `/api/undo` | restore the previous snapshot |
| POST | `/api/reserve` | hold/release a room for a VIP `{room, reserved}` |
| POST | `/api/pause` | `{paused: bool}` |
| POST | `/api/config` | save settings; requires `{pin}` |
| POST | `/api/verify-pin` | gate for the Settings page |

Everything else falls through to the static file server, which maps `/`,
`/display`, `/doctor`, `/settings` to the four HTML files and refuses paths
that normalise outside `public/` (403).

Every mutating response embeds the fresh view model, so the acting screen
updates instantly instead of waiting for its next poll. Request bodies are
JSON, capped at 1 MB, and parse failures resolve to `{}` rather than erroring.

## The view model

`publicState()` is the only shape browsers ever see. It joins config and state:
rooms come out as definition + current token, the waiting list comes out
already ordered by `orderedWaiting()`, and derived stats (counts, average wait)
are computed server-side. Raw internal state never leaves the process, and the
PIN never appears in any response.

`version` is a monotonically increasing integer bumped on every persist. It
exists so pollers can skip re-rendering when nothing changed.

## The client (`public/common.js`)

One shared object, `CQ`, used by all four pages:

- `start(ms)` polls `/api/state` (default 1.5 s). A changed `version` fires the
  page's `onState` handler; network failure shows a fixed red banner
  ("check the black window is still open") until a poll succeeds again.
- `post(path, body)` sends a command and immediately applies the state embedded
  in the response.
- `chime()` synthesises a two-tone chime with the Web Audio API — no sound
  file, nothing to download. `speak(text, lang)` uses the browser's built-in
  speech synthesis for Hindi/English announcements; token numbers are spelled
  digit-by-digit ("one zero five") to survive a noisy waiting room.
- **No `localStorage`, no `sessionStorage`.** Browsers hold render state only;
  three screens must always agree, so the server is the only source of truth.

The display page additionally requires one tap on startup — browsers refuse to
autoplay audio without a user gesture, so the tap unlocks the chime and goes
fullscreen.

## Testing

`node test.js` — no framework, ~40 assertions, ~4 s. Each test group boots a
*real* server (`child_process`) against a throwaway data directory (the
`CQ_DATA` env var exists for exactly this) and drives it over real HTTP.
Restart-survival tests kill the process and boot a new one on the same
directory; day-rollover tests plant a yesterday-dated state file on disk
before booting. Nothing is mocked, which is the point: the persistence
guarantees are the product.
