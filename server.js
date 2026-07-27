/*
 * TokenBoard - offline token/queue system for a single-doctor clinic.
 * Zero npm dependencies. Node 18+.
 *
 * Everything is written to disk immediately after every change, using
 * write -> fsync -> rename, so a power cut cannot lose or reset the counter.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { qrMatrix } = require('./qr');

const ROOT = __dirname;
// CQ_DATA lets the test suite run against a throwaway directory.
const DATA_DIR = process.env.CQ_DATA || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * Crash-safe file helpers
 * ------------------------------------------------------------------ */

function saveAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd); // force to platter before we swap it in
  } finally {
    fs.closeSync(fd);
  }
  // keep one generation of backup in case a rename is interrupted
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* non-fatal */ }
  }
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  for (const candidate of [file, file + '.bak']) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) {
      console.warn('[warn] could not read ' + candidate + ': ' + e.message);
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  clinicName: 'City Care Clinic',
  doctorName: 'Dr. Sharma',
  rooms: [
    { id: 1, name: 'Room 1', nameHi: 'कक्ष 1', color: '#0B6E77' },
    { id: 2, name: 'Room 2', nameHi: 'कक्ष 2', color: '#2C4A9A' },
    { id: 3, name: 'Room 3', nameHi: 'कक्ष 3', color: '#7A2E6B' }
  ],
  // Test rooms (X-ray, pathology, ...). Each has its own queue and its own
  // number series (X1, X2, ...), issued before or after seeing the doctor.
  // Empty by default: a clinic without them sees no change anywhere.
  services: [],

  startNumber: 1,        // first walk-in token of each morning
  resetDaily: true,      // false = counter never resets, runs forever
  urgentPrefix: 'E',     // urgent tokens look like E1, E2, ...
  urgentStartNumber: 1,
  apptPrefix: 'A',       // booked / follow-up tokens look like A1, A2, ...
  apptStartNumber: 1,

  // How booked patients and walk-ins share the queue.
  //   'mix'               interleave them by the ratio below (fairest)
  //   'appointment_first' every booked patient goes before every walk-in
  //   'arrival'           strict arrival order, separate numbering only
  queuePolicy: 'mix',
  mixAppointment: 1,     // e.g. 2 and 1 = two booked patients per walk-in
  mixWalkIn: 1,
  autoAssign: true,      // system puts patients into free rooms by itself
  announce: true,        // speak the token number on the waiting-room screen
  language: 'both',      // 'en' | 'hi' | 'both'
  port: 8080,
  pin: '1234'            // protects the Settings page only
};

let config = Object.assign({}, DEFAULT_CONFIG, loadJson(CONFIG_FILE, {}));
if (!Array.isArray(config.rooms) || config.rooms.length === 0) {
  config.rooms = DEFAULT_CONFIG.rooms;
}
if (!Array.isArray(config.services)) config.services = [];
saveAtomic(CONFIG_FILE, config);

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function todayKey(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

function stateFile(day) {
  return path.join(DATA_DIR, 'state-' + day + '.json');
}

function freshState(day, carry) {
  carry = carry || {};
  return {
    date: day,
    version: 1,
    nextId: 1,
    lastNormal: (carry.normal != null) ? carry.normal : config.startNumber - 1,
    lastUrgent: (carry.urgent != null) ? carry.urgent : config.urgentStartNumber - 1,
    lastAppt: (carry.appt != null) ? carry.appt : config.apptStartNumber - 1,
    // how many of each kind have actually been called in, used by the 'mix' policy
    served: { appointment: 0, normal: 0 },
    cyclePos: 0,
    tokens: [],
    rooms: config.rooms.map(r => ({ id: r.id, tokenId: null, reserved: false })),
    services: config.services.map(s => ({ id: s.id, tokenId: null })),
    lastService: carry.services || {},   // serviceId -> last number issued
    paused: false
  };
}

let state;
let history = []; // in-memory undo stack

function loadTodayState() {
  const day = todayKey();
  let s = loadJson(stateFile(day), null);

  if (!s) {
    // No file for today. If the counter must run continuously, carry it over
    // from the most recent day we have on disk.
    let carry = null;
    if (!config.resetDaily) {
      const prev = fs.readdirSync(DATA_DIR)
        .filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .pop();
      if (prev) {
        const p = loadJson(path.join(DATA_DIR, prev), null);
        if (p) carry = { normal: p.lastNormal, urgent: p.lastUrgent, appt: p.lastAppt, services: p.lastService };
      }
    }
    s = freshState(day, carry);
    saveAtomic(stateFile(day), s);
  }

  // tolerate files written by an older version of this program
  if (s.lastAppt == null) s.lastAppt = config.apptStartNumber - 1;
  if (!s.served) s.served = { appointment: 0, normal: 0 };
  if (s.cyclePos == null) s.cyclePos = 0;
  if (!s.lastService) s.lastService = {};

  // reconcile rooms if the doctor changed room count in Settings
  const byId = new Map((s.rooms || []).map(r => [r.id, r]));
  s.rooms = config.rooms.map(r => byId.get(r.id) || { id: r.id, tokenId: null, reserved: false });
  for (const room of s.rooms) if (room.reserved == null) room.reserved = false;

  const svcById = new Map((s.services || []).map(x => [x.id, x]));
  s.services = config.services.map(sc => svcById.get(sc.id) || { id: sc.id, tokenId: null });

  return s;
}

state = loadTodayState();

/* If the clinic PC was switched off overnight, yesterday never had a chance to
   archive itself. Catch up on every past day that has no CSV yet. */
function archivePendingDays() {
  const today = todayKey();
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^state-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m || m[1] === today) continue;
    const csv = path.join(ARCHIVE_DIR, m[1] + '.csv');
    if (fs.existsSync(csv)) continue;
    const past = loadJson(path.join(DATA_DIR, f), null);
    if (past) archiveToCsv(past);
  }
}

function persist() {
  state.version++;
  saveAtomic(stateFile(state.date), state);
}

function snapshot() {
  history.push(JSON.stringify(state));
  if (history.length > 30) history.shift();
}

function rollDayIfNeeded() {
  const day = todayKey();
  if (state.date === day) return;
  archiveToCsv(state);
  const carry = config.resetDaily ? null
    : { normal: state.lastNormal, urgent: state.lastUrgent, appt: state.lastAppt, services: state.lastService };
  state = freshState(day, carry);
  history = [];
  persist();
  console.log('[info] new clinic day started: ' + day);
}

/* ------------------------------------------------------------------ *
 * Queue logic
 * ------------------------------------------------------------------ */

const KINDS = ['normal', 'urgent', 'appointment'];

function labelFor(kind, n) {
  if (kind === 'urgent') return config.urgentPrefix + n;
  if (kind === 'appointment') return config.apptPrefix + n;
  return String(n);
}

/* A number for a test room. Outside the doctor's queue entirely: its own
   series, its own station, issued before the doctor or when the doctor
   asks for the test - the mechanics are the same either way. */
function makeServiceToken(svc, name, returnTo) {
  if (state.lastService[svc.id] == null) state.lastService[svc.id] = 0;
  const num = ++state.lastService[svc.id];
  const token = {
    id: state.nextId++,
    kind: 'service',
    serviceId: svc.id,
    number: num,
    label: (svc.prefix || 'S') + num,
    name: (name || '').trim().slice(0, 40),
    returnTo: returnTo || null,   // doctor token to bring back when the test is done
    status: 'waiting',
    room: null,
    createdAt: Date.now(),
    calledAt: null,
    doneAt: null
  };
  state.tokens.push(token);
  return token;
}

function issueServiceToken(serviceId, name) {
  rollDayIfNeeded();
  const svc = config.services.find(s => s.id === Number(serviceId));
  if (!svc) return null;
  snapshot();
  const token = makeServiceToken(svc, name, null);
  autoAssign();
  persist();
  return token;
}

/* The doctor sends the patient in a room for a test. One action - and one
   undo - frees the room, issues a linked test number, and remembers who to
   bring back to the doctor when the test room finishes with them. */
function sendForTest(roomId, serviceId) {
  rollDayIfNeeded();
  const room = state.rooms.find(r => r.id === Number(roomId));
  const svc = config.services.find(s => s.id === Number(serviceId));
  if (!room || !room.tokenId || !svc) return null;
  snapshot();
  const patient = state.tokens.find(x => x.id === room.tokenId);
  patient.status = 'done';
  patient.doneAt = Date.now();
  room.tokenId = null;
  const token = makeServiceToken(svc, patient.name, patient.id);
  autoAssign();
  persist();
  return token;
}

function serviceWaiting(serviceId) {
  return state.tokens
    .filter(t => t.kind === 'service' && t.serviceId === serviceId && t.status === 'waiting')
    .sort((a, b) => a.id - b.id);
}

function issueToken(kind, name) {
  rollDayIfNeeded();
  snapshot();
  if (KINDS.indexOf(kind) === -1) kind = 'normal';

  let num;
  if (kind === 'urgent') { state.lastUrgent += 1; num = state.lastUrgent; }
  else if (kind === 'appointment') { state.lastAppt += 1; num = state.lastAppt; }
  else { state.lastNormal += 1; num = state.lastNormal; }

  const token = {
    id: state.nextId++,
    kind: kind,
    number: num,
    label: labelFor(kind, num),
    name: (name || '').trim().slice(0, 40),
    status: 'waiting',
    room: null,
    createdAt: Date.now(),
    calledAt: null,
    doneAt: null
  };
  state.tokens.push(token);
  autoAssign();
  persist();
  return token;
}

/* The repeating booked/walk-in pattern, e.g. 2:1 -> ['A','A','W']. */
function mixPattern() {
  const wA = Math.min(9, Math.max(1, Number(config.mixAppointment) || 1));
  const wW = Math.min(9, Math.max(1, Number(config.mixWalkIn) || 1));
  const out = [];
  for (let k = 0; k < wA; k++) out.push('A');
  for (let k = 0; k < wW; k++) out.push('W');
  return out;
}

/* Move along the pattern, using the same substitution rule as orderedWaiting:
   a patient who only filled in for an empty stream does not consume a slot. */
function advanceCycle(kind) {
  if (kind !== 'appointment' && kind !== 'normal') return;
  const pattern = mixPattern();
  const p = (state.cyclePos || 0) % pattern.length;
  const want = pattern[p] === 'A' ? 'appointment' : 'normal';
  state.cyclePos = (kind === want) ? (p + 1) % pattern.length : p;
}

/*
 * The order everyone will actually be called in.
 *
 * Emergencies always come first. Booked patients and walk-ins then share the
 * remaining places according to the clinic's chosen policy. This returns the
 * whole projected order, not just the next person, so the waiting-room screen
 * shows exactly what is going to happen.
 */
function orderedWaiting() {
  const byArrival = (a, b) => a.id - b.id;
  const waiting = state.tokens.filter(t => t.status === 'waiting');

  const urgent = waiting.filter(t => t.kind === 'urgent').sort(byArrival);
  // back from a test the doctor ordered: next in line, right behind urgent -
  // their consultation is a continuation, not a new turn
  const returning = waiting.filter(t => t.kind !== 'urgent' && t.returning).sort(byArrival);
  const appt = waiting.filter(t => t.kind === 'appointment' && !t.returning).sort(byArrival);
  const walk = waiting.filter(t => t.kind === 'normal' && !t.returning).sort(byArrival);

  const out = urgent.concat(returning);

  if (config.queuePolicy === 'arrival') {
    return out.concat(appt.concat(walk).sort(byArrival));
  }
  if (config.queuePolicy === 'appointment_first') {
    return out.concat(appt, walk);
  }

  // 'mix': walk a repeating pattern, e.g. 2 booked then 1 walk-in = [A,A,W].
  // Deliberately literal rather than a smoothed weighting, because the doctor
  // has to be able to predict the order from the two numbers he typed in.
  //
  // If the slot's stream is empty we serve the other stream instead but leave
  // the position untouched, so the pattern resumes intact once they turn up.
  const pattern = mixPattern();
  let p = (state.cyclePos || 0) % pattern.length;
  let i = 0, j = 0;

  while (i < appt.length || j < walk.length) {
    if (pattern[p] === 'A') {
      if (i < appt.length) { out.push(appt[i++]); p = (p + 1) % pattern.length; }
      else out.push(walk[j++]);
    } else {
      if (j < walk.length) { out.push(walk[j++]); p = (p + 1) % pattern.length; }
      else out.push(appt[i++]);
    }
  }
  return out;
}

function callInto(roomId, token) {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room || !token) return;
  token.status = 'in_room';
  token.room = roomId;
  token.calledAt = Date.now();
  room.tokenId = token.id;
  if (token.returning) {
    // a continuation after a test: like urgent, outside the fair-share
    // arrangement - it must not consume a pattern slot
    token.returning = false;
  } else {
    // emergencies are outside the fair-share arrangement
    if (token.kind === 'appointment') state.served.appointment++;
    else if (token.kind === 'normal') state.served.normal++;
    advanceCycle(token.kind);
  }
}

function autoAssign() {
  if (config.autoAssign && !state.paused) {
    for (const room of state.rooms) {
      if (room.tokenId || room.reserved) continue;
      const next = orderedWaiting()[0];
      if (!next) break;
      callInto(room.id, next);
    }
  }
  // Test rooms always pull their own queue, in arrival order, even while the
  // doctor's queue is paused: the X-ray keeps working through the lunch break.
  // They never touch the fair-share cycle - that belongs to the doctor's queue.
  for (const st of state.services) {
    if (st.tokenId) continue;
    const next = serviceWaiting(st.id)[0];
    if (!next) continue;
    next.status = 'in_room';
    next.calledAt = Date.now();
    st.tokenId = next.id;
  }
}

function callNextInto(roomId) {
  rollDayIfNeeded();
  snapshot();
  const room = state.rooms.find(r => r.id === roomId);
  if (room && !room.tokenId && !room.reserved) callInto(roomId, orderedWaiting()[0]);
  persist();
}

function markDone(roomId) {
  rollDayIfNeeded();
  snapshot();
  const room = state.rooms.find(r => r.id === roomId);
  if (room && room.tokenId) {
    const t = state.tokens.find(x => x.id === room.tokenId);
    if (t) { t.status = 'done'; t.doneAt = Date.now(); t.room = roomId; }
    room.tokenId = null;
  }
  autoAssign();
  persist();
}

function markServiceDone(serviceId) {
  rollDayIfNeeded();
  snapshot();
  const st = state.services.find(s => s.id === Number(serviceId));
  if (st && st.tokenId) {
    const t = state.tokens.find(x => x.id === st.tokenId);
    if (t) {
      t.status = 'done';
      t.doneAt = Date.now();
      // a patient the doctor sent: bring their original number back to the
      // front of the doctor's queue - the consultation is being continued
      const back = t.returnTo != null ? state.tokens.find(x => x.id === t.returnTo) : null;
      if (back && back.status !== 'in_room') {
        back.status = 'waiting';
        back.room = null;
        back.doneAt = null;
        back.returning = true;
        back.returnedFrom = (config.services.find(sc => sc.id === t.serviceId) || { name: 'test' }).name;
      }
    }
    st.tokenId = null;
  }
  autoAssign();
  persist();
}

function skipToken(tokenId) {
  rollDayIfNeeded();
  snapshot();
  const t = state.tokens.find(x => x.id === tokenId);
  if (t) {
    if (t.room != null) {
      const room = state.rooms.find(r => r.id === t.room);
      if (room && room.tokenId === t.id) room.tokenId = null;
    }
    const st = state.services.find(s => s.tokenId === t.id);
    if (st) st.tokenId = null;
    t.status = 'skipped';
    t.room = null;
  }
  autoAssign();
  persist();
}

function recallToken(tokenId) {
  rollDayIfNeeded();
  snapshot();
  const t = state.tokens.find(x => x.id === tokenId);
  if (t && (t.status === 'skipped' || t.status === 'done')) {
    t.status = 'waiting';
    t.room = null;
    t.doneAt = null;
  }
  autoAssign();
  persist();
}

function undo() {
  const prev = history.pop();
  if (!prev) return false;
  const restored = JSON.parse(prev);
  if (restored.date !== todayKey()) return false;
  state = restored;
  persist();
  return true;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function csvFor(s) {
  const head = 'token,type,name,issued_at,called_at,done_at,room,wait_minutes,status\n';
  const rows = s.tokens.map(t => {
    const wait = t.calledAt ? Math.round((t.calledAt - t.createdAt) / 60000) : '';
    const fmt = ms => ms ? new Date(ms).toLocaleTimeString('en-GB') : '';
    const safe = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    return [safe(t.label), t.kind, safe(t.name), fmt(t.createdAt), fmt(t.calledAt),
      fmt(t.doneAt), t.room == null ? '' : t.room, wait, t.status].join(',');
  });
  return head + rows.join('\n') + '\n';
}

function archiveToCsv(s) {
  if (!s || !s.tokens || s.tokens.length === 0) return;
  try {
    fs.writeFileSync(path.join(ARCHIVE_DIR, s.date + '.csv'), csvFor(s), 'utf8');
  } catch (e) {
    console.warn('[warn] could not archive ' + s.date + ': ' + e.message);
  }
}

/* ------------------------------------------------------------------ *
 * View model handed to the browsers
 * ------------------------------------------------------------------ */

function publicState() {
  rollDayIfNeeded();
  const byId = new Map(state.tokens.map(t => [t.id, t]));
  const waiting = orderedWaiting();
  // "done" and the average wait mean the doctor's queue; test rooms are
  // reported separately in the services block below
  const done = state.tokens.filter(t => t.status === 'done' && t.kind !== 'service');
  const waits = done.filter(t => t.calledAt).map(t => (t.calledAt - t.createdAt) / 60000);
  const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;

  return {
    version: state.version,
    date: state.date,
    paused: state.paused,
    clinicName: config.clinicName,
    doctorName: config.doctorName,
    language: config.language,
    announce: config.announce,
    autoAssign: config.autoAssign,
    urgentPrefix: config.urgentPrefix,
    apptPrefix: config.apptPrefix,
    queuePolicy: config.queuePolicy,
    rooms: config.rooms.map(rc => {
      const rs = state.rooms.find(r => r.id === rc.id) || { tokenId: null };
      const t = rs.tokenId ? byId.get(rs.tokenId) : null;
      return {
        id: rc.id,
        name: rc.name,
        nameHi: rc.nameHi || rc.name,
        color: rc.color || '#2C4A9A',
        reserved: !!rs.reserved,
        token: t ? { id: t.id, label: t.label, kind: t.kind, name: t.name, calledAt: t.calledAt } : null
      };
    }),
    services: config.services.map(sc => {
      const st = state.services.find(x => x.id === sc.id) || { tokenId: null };
      const t = st.tokenId ? byId.get(st.tokenId) : null;
      const queue = serviceWaiting(sc.id);
      return {
        id: sc.id,
        name: sc.name,
        nameHi: sc.nameHi || sc.name,
        color: sc.color || '#4A5568',
        prefix: sc.prefix,
        token: t ? { id: t.id, label: t.label, calledAt: t.calledAt } : null,
        next: queue.slice(0, 3).map(x => x.label),
        waitingCount: queue.length
      };
    }),
    waiting: waiting.map(t => ({
      id: t.id, label: t.label, kind: t.kind, name: t.name, createdAt: t.createdAt,
      returning: !!t.returning, returnedFrom: t.returnedFrom || null
    })),
    skipped: state.tokens.filter(t => t.status === 'skipped')
      .map(t => ({ id: t.id, label: t.label, kind: t.kind, name: t.name })),
    recentDone: done.slice(-8).reverse()
      .map(t => ({ id: t.id, label: t.label, kind: t.kind, name: t.name })),
    stats: {
      waiting: waiting.length,
      inRoom: state.rooms.filter(r => r.tokenId).length,
      done: done.length,
      total: state.tokens.length,
      avgWait: avgWait
    },
    canUndo: history.length > 0
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { data = ''; req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/reception.html' : urlPath;
  if (rel === '/display') rel = '/display.html';
  if (rel === '/doctor') rel = '/doctor.html';
  if (rel === '/settings') rel = '/settings.html';
  if (rel === '/reception') rel = '/reception.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/state') return sendJson(res, 200, publicState());

    if (p === '/api/report.csv') {
      const body = csvFor(state);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="clinic-' + state.date + '.csv"'
      });
      return res.end('\uFEFF' + body);
    }

    if (p === '/api/config' && req.method === 'GET') {
      const safe = Object.assign({}, config);
      delete safe.pin;
      return sendJson(res, 200, safe);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (p === '/api/token') {
        const t = body.kind === 'service'
          ? issueServiceToken(body.service, body.name)
          : issueToken(body.kind, body.name);
        if (!t) return sendJson(res, 200, { ok: false, error: 'No such test room' });
        return sendJson(res, 200, { ok: true, token: t, state: publicState() });
      }
      if (p === '/api/done') { markDone(Number(body.room)); return sendJson(res, 200, { ok: true, state: publicState() }); }
      if (p === '/api/service-done') { markServiceDone(Number(body.service)); return sendJson(res, 200, { ok: true, state: publicState() }); }
      if (p === '/api/send-test') {
        const t = sendForTest(body.room, body.service);
        if (!t) return sendJson(res, 200, { ok: false, error: 'No patient in that room' });
        return sendJson(res, 200, { ok: true, token: t, state: publicState() });
      }
      if (p === '/api/call') { callNextInto(Number(body.room)); return sendJson(res, 200, { ok: true, state: publicState() }); }
      if (p === '/api/skip') { skipToken(Number(body.id)); return sendJson(res, 200, { ok: true, state: publicState() }); }
      if (p === '/api/recall') { recallToken(Number(body.id)); return sendJson(res, 200, { ok: true, state: publicState() }); }
      if (p === '/api/undo') { const ok = undo(); return sendJson(res, 200, { ok, state: publicState() }); }

      if (p === '/api/reserve') {
        rollDayIfNeeded();
        const room = state.rooms.find(r => r.id === Number(body.room));
        if (!room) return sendJson(res, 200, { ok: false, error: 'No such room' });
        snapshot();
        // an occupied room can be reserved too: the current patient finishes
        // normally and the room is then simply not refilled
        room.reserved = !!body.reserved;
        if (!room.reserved) autoAssign();
        persist();
        return sendJson(res, 200, { ok: true, state: publicState() });
      }

      if (p === '/api/pause') {
        snapshot(); state.paused = !!body.paused;
        if (!state.paused) autoAssign();
        persist();
        return sendJson(res, 200, { ok: true, state: publicState() });
      }

      if (p === '/api/config') {
        if (String(body.pin || '') !== String(config.pin)) {
          return sendJson(res, 403, { ok: false, error: 'Wrong PIN' });
        }
        const incoming = body.config || {};
        const allowed = ['clinicName', 'doctorName', 'rooms', 'services', 'startNumber', 'resetDaily',
          'urgentPrefix', 'urgentStartNumber', 'apptPrefix', 'apptStartNumber',
          'queuePolicy', 'mixAppointment', 'mixWalkIn',
          'autoAssign', 'announce', 'language', 'pin'];
        for (const k of allowed) {
          if (incoming[k] !== undefined) config[k] = incoming[k];
        }
        if (!Array.isArray(config.rooms) || !config.rooms.length) config.rooms = DEFAULT_CONFIG.rooms;
        config.rooms = config.rooms.slice(0, 6).map((r, i) => ({
          id: i + 1,
          name: (r.name || ('Room ' + (i + 1))).slice(0, 24),
          nameHi: (r.nameHi || r.name || ('कक्ष ' + (i + 1))).slice(0, 24),
          color: /^#[0-9a-fA-F]{6}$/.test(r.color || '') ? r.color : '#2C4A9A'
        }));
        config.services = (Array.isArray(config.services) ? config.services : [])
          .slice(0, 4).map((s, i) => ({
            id: i + 1,
            name: (s.name || ('Test room ' + (i + 1))).slice(0, 24),
            nameHi: (s.nameHi || s.name || '').slice(0, 24),
            prefix: (String(s.prefix || '').trim().toUpperCase().slice(0, 2)) || 'S',
            color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : '#4A5568'
          }));
        saveAtomic(CONFIG_FILE, config);

        // free any room that no longer exists
        const ids = new Set(config.rooms.map(r => r.id));
        for (const rs of state.rooms) {
          if (!ids.has(rs.id) && rs.tokenId) {
            const t = state.tokens.find(x => x.id === rs.tokenId);
            if (t) { t.status = 'waiting'; t.room = null; }
          }
        }
        const byId = new Map(state.rooms.map(r => [r.id, r]));
        state.rooms = config.rooms.map(r => byId.get(r.id) || { id: r.id, tokenId: null });

        // same for test rooms: a patient inside a removed one rejoins its queue
        const svcIds = new Set(config.services.map(s => s.id));
        for (const st of state.services) {
          if (!svcIds.has(st.id) && st.tokenId) {
            const t = state.tokens.find(x => x.id === st.tokenId);
            if (t) t.status = 'waiting';
          }
        }
        const svcById = new Map(state.services.map(s => [s.id, s]));
        state.services = config.services.map(s => svcById.get(s.id) || { id: s.id, tokenId: null });
        autoAssign();
        persist();
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/verify-pin') {
        return sendJson(res, 200, { ok: String(body.pin || '') === String(config.pin) });
      }
    }

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[error]', err);
    return sendJson(res, 500, { ok: false, error: String(err && err.message) });
  }
});

/* Render a QR matrix with half-height blocks, two module rows per console
   line. Light modules are printed as white blocks because the console is
   white-on-black: the black background becomes the dark modules. */
function qrConsoleLines(matrix) {
  const quiet = 2; // half the spec's quiet zone; the black console adds the rest
  const size = matrix.length + quiet * 2;
  const dark = (r, c) => {
    if (r < quiet || c < quiet || r >= size - quiet || c >= size - quiet) return false;
    return matrix[r - quiet][c - quiet] === 1;
  };
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = !dark(r, c);
      const bottom = (r + 1 < size) ? !dark(r + 1, c) : true;
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(line);
  }
  return lines;
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const PORT = Number(process.env.PORT || config.port || 8080);
server.listen(PORT, '0.0.0.0', () => {
  try { archivePendingDays(); } catch (e) { console.warn('[warn] archive catch-up: ' + e.message); }
  const lan = lanAddresses();
  console.log('');
  console.log('  ' + config.clinicName + '  -  queue system running');
  console.log('  ------------------------------------------------');
  console.log('  Reception   http://localhost:' + PORT + '/');
  console.log('  TV display  http://localhost:' + PORT + '/display');
  console.log('  Doctor      http://localhost:' + PORT + '/doctor');
  console.log('  Settings    http://localhost:' + PORT + '/settings');
  if (lan.length) {
    const doctorUrl = 'http://' + lan[0] + ':' + PORT + '/doctor';
    console.log('');
    console.log('  On phone/tablet (same WiFi):  ' + doctorUrl);
    try {
      console.log('  Or point the phone camera at this square:');
      console.log('');
      for (const line of qrConsoleLines(qrMatrix(doctorUrl))) console.log('   ' + line);
    } catch (e) { /* the QR is a nicety, never fatal */ }
  }
  console.log('');
  console.log('  Today: ' + state.date + '   Keep this black window open.');
  console.log('');
});

// flush current state on a clean shutdown too
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { persist(); archiveToCsv(state); } catch (e) {} process.exit(0); });
}
