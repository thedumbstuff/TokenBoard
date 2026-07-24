# TokenBoard

A token/queue system for a single doctor with several examination rooms.
Runs entirely on one Windows PC. No internet, no cloud account, no monthly fee.

Built for the real situation in a busy clinic: the receptionist hands out numbers,
the doctor moves from room to room, and the power goes out without warning.

---

## What each screen does

| Screen | Who uses it | Address |
|---|---|---|
| **Reception** | Receptionist | `http://localhost:8080/` |
| **Waiting room display** | Patients (TV / second monitor) | `http://localhost:8080/display` |
| **Doctor** | Doctor's phone or tablet | `http://<pc-ip>:8080/doctor` |
| **Settings** | Doctor / owner, PIN protected | `http://localhost:8080/settings` |

---

## Installing (about 10 minutes, once)

1. Install **Node.js** from <https://nodejs.org> — the green **LTS** button, then Next
   until it finishes. This is the only thing that needs installing.
2. Copy the `TokenBoard` folder anywhere on the PC, e.g. `C:\TokenBoard`.
3. Right-click **`SETUP - run once.bat`** → **Run as administrator**.
   It creates a desktop icon, makes the system start by itself after a power cut,
   and opens the firewall so the doctor's phone can connect.
4. Open **Settings**, enter PIN `1234`, and fill in the clinic name, doctor name,
   rooms and starting number. Change the PIN while you are there.

Every morning after that: the system starts on its own when Windows starts.
If it doesn't, double-click the **TokenBoard** icon on the desktop.

### Putting the display on the TV

Connect the TV to the PC with an HDMI cable and set Windows to **Extend** these
displays (`Windows key + P` → Extend). Drag the display window onto the TV,
press **F11** for full screen, then click once on it — that one click is what
allows the browser to speak the announcements.

---

## Power cuts

Every single change is written to disk and flushed immediately, then the file is
swapped in atomically. If the power dies mid-sentence the old file is still intact,
and a `.bak` copy sits beside it.

When the power returns and Windows boots, the system starts by itself and comes
back exactly where it was — same token counter, same patients in the same rooms,
same waiting list. Nothing is retyped and the counter never jumps back to 1.

Tested by killing the process with no warning at all (`kill -9`), which is harsher
than a power cut.

**Strongly recommended anyway:** a small UPS (₹2,500–4,000) so the PC shuts down
cleanly and the TV doesn't flicker off every time. It also protects the hard disk,
which is the one thing that a software design cannot protect.

---

## How the numbers work

There are three separate series, so they can never be confused with each other:

| Patient | Number | Colour |
|---|---|---|
| Walk-in | `1, 2, 3, …` | black |
| Booked / follow-up | `A1, A2, A3, …` | ochre |
| Urgent | `E1, E2, E3, …` | red |

The letter is the real signal and the colour is a second, faster cue — so the
system still works on a black-and-white printout or for a colour-blind patient.
The starting number and the two letters are all changeable in Settings.

Each morning every counter goes back to its starting number automatically.
If you prefer numbers that run continuously for months, turn off
*"Start again from the first number every morning"*.

### Who gets called first

**Urgent patients always go before everyone else**, in all cases. Booked patients
and walk-ins then share the remaining places, in one of three ways you choose in
Settings:

- **Take turns** *(default)* — a repeating pattern you set, such as
  1 booked : 1 walk-in → `A1, 1, A2, 2, …`, or 2 booked : 1 walk-in →
  `A1, A2, 1, A3, A4, 2, …`. Neither group is ever left stranded.
- **Booked patients always go first** — every appointment before any walk-in.
- **Whoever arrived first** — one plain queue; the three series exist only so the
  numbers stay distinguishable.

If one group runs out, the other simply continues, and the pattern picks up
where it left off when they turn up again. Settings shows the resulting order
in words as you change the numbers, so there is no guesswork.

## How patients reach a room

The receptionist never chooses a room. When a room becomes free, the system sends
the next person in automatically and the waiting-room screen shows the number on
that room's colour panel, with a chime and a spoken announcement in Hindi and English.

Stick a coloured paper on each door matching the colour in Settings. A patient who
cannot read "Room 2" can still match the colour.

---

## The receptionist's whole job (print this part)

**Giving a number**

- Ordinary walk-in patient → the big **green** button.
- Patient with an appointment, or coming back for a follow-up → the big **ochre** button.
- Urgent patient → the big **red** button.

The number then fills the screen. Write it on the patient's OPD slip and tell them
the number out loud. Press **+ Next patient** to serve the next person straight
away without closing anything, or wait — it clears by itself after 15 seconds.

**When the doctor has finished with a patient**

- Press the green **✓ Checked** button under that room.

The next patient is sent in automatically.

**If something goes wrong**

- Pressed the wrong button? → **Undo last** at the top right.
- Patient not answering when called? → **Patient not here**. They move to a
  "Did not answer" list and can be called again later with one button.

Keyboard shortcuts once she is comfortable: **F2** = walk-in, **F3** = booked,
**F4** = urgent.

**The black window must stay open.** If it is closed the system stops. If it is
ever closed by mistake, double-click the desktop icon again — nothing is lost.

---

## End of day

Nothing needs to be done. The day is saved automatically and a spreadsheet is
written to `data\archive\YYYY-MM-DD.csv`, which opens in Excel and shows every
patient, their waiting time and which room they were seen in.

The doctor's screen has a **Download today's list** button for the current day.

---

## Files

```
TokenBoard\
  START CLINIC.bat        <- the one to run
  SETUP - run once.bat    <- first-time install
  open-screens.bat        <- helper, runs by itself
  server.js               <- the whole system (no libraries used)
  public\                 <- the four screens
  data\
    config.json           <- clinic settings
    state-YYYY-MM-DD.json <- today's live queue
    archive\              <- one CSV per finished day
```

To move to a new PC, copy the whole folder. To back up, copy `data\`.

To reset everything and start clean, close the system and delete the `data` folder.

---

## Changing the port

If something else already uses port 8080, edit `port` in `data\config.json`
and change `set PORT=8080` in `open-screens.bat` to match.
