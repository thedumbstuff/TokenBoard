/*
 * TokenBoard test suite.  Run with:  node test.js
 *
 * No test framework, no dependencies - same rule as the rest of the project.
 * Every test starts a real server against a throwaway data directory and talks
 * to it over HTTP, so what is verified is the actual behaviour a clinic sees.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok   ' + name); }
  else {
    failed++;
    failures.push(name);
    console.log('  FAIL ' + name + '\n         expected ' + e + '\n         actual   ' + a);
  }
}

function ok(name, cond) { check(name, !!cond, true); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- harness ---------- */

let portCounter = 8391;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-test-'));

function dataDir(name) {
  const d = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(d, 'archive'), { recursive: true });
  return d;
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

async function start(dir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { CQ_DATA: dir, PORT: String(port) }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/state');
      if (r.ok) return proc;
    } catch (e) { /* not up yet */ }
    await sleep(60);
  }
  proc.kill('SIGKILL');
  throw new Error('server on port ' + port + ' never came up');
}

function stop(proc, hard) {
  return new Promise(resolve => {
    proc.once('exit', () => resolve());
    proc.kill(hard ? 'SIGKILL' : 'SIGTERM');
    setTimeout(resolve, 1500);
  });
}

const api = {
  get: (port, p) => fetch('http://127.0.0.1:' + port + p).then(r => r.json()),
  post: (port, p, body) => fetch('http://127.0.0.1:' + port + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r => r.json())
};

const baseConfig = (over) => Object.assign({
  clinicName: 'Test Clinic',
  doctorName: 'Dr Test',
  rooms: [{ id: 1, name: 'Room 1', nameHi: 'कक्ष 1', color: '#0B6E77' }],
  startNumber: 1,
  resetDaily: true,
  urgentPrefix: 'E',
  urgentStartNumber: 1,
  apptPrefix: 'A',
  apptStartNumber: 1,
  queuePolicy: 'mix',
  mixAppointment: 1,
  mixWalkIn: 1,
  autoAssign: true,
  announce: true,
  language: 'both',
  pin: '1234'
}, over || {});

const labels = s => s.waiting.map(t => t.label);
const inRooms = s => s.rooms.map(r => r.token ? r.token.label : null);

/* ---------- tests ---------- */

async function testNumbering() {
  console.log('\nthree independent number series');
  const dir = dataDir('numbering'), port = portCounter++;
  writeConfig(dir, baseConfig({ startNumber: 101 }));
  const p = await start(dir, port);

  const a = await api.post(port, '/api/token', { kind: 'normal' });
  const b = await api.post(port, '/api/token', { kind: 'normal' });
  const c = await api.post(port, '/api/token', { kind: 'appointment' });
  const d = await api.post(port, '/api/token', { kind: 'urgent' });
  const e = await api.post(port, '/api/token', { kind: 'appointment' });

  check('walk-ins start at the configured number', [a.token.label, b.token.label], ['101', '102']);
  check('booked patients use their own series', [c.token.label, e.token.label], ['A1', 'A2']);
  check('urgent patients use their own series', d.token.label, 'E1');
  check('an unknown kind falls back to walk-in',
    (await api.post(port, '/api/token', { kind: 'nonsense' })).token.label, '103');

  await stop(p);
}

async function testAutoAssignAndUrgent() {
  console.log('\nrooms fill by themselves, urgent patients pre-empt');
  const dir = dataDir('rooms'), port = portCounter++;
  writeConfig(dir, baseConfig({
    rooms: [
      { id: 1, name: 'Room 1', nameHi: 'क1', color: '#0B6E77' },
      { id: 2, name: 'Room 2', nameHi: 'क2', color: '#2C4A9A' },
      { id: 3, name: 'Room 3', nameHi: 'क3', color: '#7A2E6B' }
    ]
  }));
  const p = await start(dir, port);

  for (let i = 0; i < 5; i++) await api.post(port, '/api/token', { kind: 'normal' });
  let s = await api.get(port, '/api/state');
  check('all three rooms filled without anyone assigning them', inRooms(s), ['1', '2', '3']);
  check('the rest wait outside', labels(s), ['4', '5']);

  await api.post(port, '/api/token', { kind: 'urgent' });
  s = await api.get(port, '/api/state');
  check('an emergency goes to the front of the queue', labels(s), ['E1', '4', '5']);

  s = (await api.post(port, '/api/done', { room: 2 })).state;
  check('the emergency takes the freed room, not token 4', inRooms(s), ['1', 'E1', '3']);
  check('and the walk-ins keep their order', labels(s), ['4', '5']);

  await stop(p);
}

async function orderFor(policy, wA, wW) {
  const dir = dataDir('policy-' + policy + '-' + wA + '-' + wW);
  const port = portCounter++;
  // one room only, so the calling order is fully visible in the waiting list
  writeConfig(dir, baseConfig({ queuePolicy: policy, mixAppointment: wA, mixWalkIn: wW }));
  const p = await start(dir, port);
  for (const k of ['normal', 'normal', 'normal', 'normal',
                   'appointment', 'appointment', 'appointment', 'appointment']) {
    await api.post(port, '/api/token', { kind: k });
  }
  const s = await api.get(port, '/api/state');
  await stop(p);
  return [inRooms(s)[0]].concat(labels(s));
}

async function testPolicies() {
  console.log('\nhow booked patients and walk-ins share the queue');
  check('take turns 1:1', await orderFor('mix', 1, 1),
    ['1', 'A1', '2', 'A2', '3', 'A3', '4', 'A4']);
  check('take turns 2 booked : 1 walk-in', await orderFor('mix', 2, 1),
    ['1', 'A1', 'A2', '2', 'A3', 'A4', '3', '4']);
  check('take turns 1 booked : 2 walk-ins', await orderFor('mix', 1, 2),
    ['1', 'A1', '2', '3', 'A2', '4', 'A3', 'A4']);
  check('booked patients always first', await orderFor('appointment_first', 1, 1),
    ['1', 'A1', 'A2', 'A3', 'A4', '2', '3', '4']);
  check('strict arrival order', await orderFor('arrival', 1, 1),
    ['1', '2', '3', '4', 'A1', 'A2', 'A3', 'A4']);
}

async function testPatternResumes() {
  console.log('\nthe take-turns pattern survives a gap in one stream');
  const dir = dataDir('resume'), port = portCounter++;
  writeConfig(dir, baseConfig({ queuePolicy: 'mix', mixAppointment: 1, mixWalkIn: 1 }));
  const p = await start(dir, port);

  // a quiet spell with walk-ins only: they must not use up the booked slots
  for (let i = 0; i < 4; i++) await api.post(port, '/api/token', { kind: 'normal' });
  for (let i = 0; i < 4; i++) await api.post(port, '/api/done', { room: 1 });

  for (let i = 0; i < 3; i++) await api.post(port, '/api/token', { kind: 'appointment' });
  for (let i = 0; i < 3; i++) await api.post(port, '/api/token', { kind: 'normal' });

  const s = await api.get(port, '/api/state');
  check('alternation resumes cleanly, no burst of booked numbers',
    [inRooms(s)[0]].concat(labels(s)),
    ['A1', '5', 'A2', '6', 'A3', '7']);

  await stop(p);
}

async function testPowerCut() {
  console.log('\npower cut');
  const dir = dataDir('power'), port = portCounter++;
  writeConfig(dir, baseConfig({
    rooms: [
      { id: 1, name: 'Room 1', nameHi: 'क1', color: '#0B6E77' },
      { id: 2, name: 'Room 2', nameHi: 'क2', color: '#2C4A9A' }
    ]
  }));
  let p = await start(dir, port);
  for (const k of ['normal', 'appointment', 'normal', 'urgent', 'appointment']) {
    await api.post(port, '/api/token', { kind: k });
  }
  const before = await api.get(port, '/api/state');

  await stop(p, true);                     // SIGKILL: no chance to tidy up
  p = await start(dir, port);
  const after = await api.get(port, '/api/state');

  check('patients are still in the same rooms', inRooms(after), inRooms(before));
  check('the waiting queue is unchanged', labels(after), labels(before));
  check('the counters carry on rather than resetting',
    [(await api.post(port, '/api/token', { kind: 'normal' })).token.label,
     (await api.post(port, '/api/token', { kind: 'appointment' })).token.label,
     (await api.post(port, '/api/token', { kind: 'urgent' })).token.label],
    ['3', 'A3', 'E2']);

  await stop(p);
}

function yesterdayKey() {
  const d = new Date(Date.now() - 86400000);
  const q = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + q(d.getMonth() + 1) + '-' + q(d.getDate());
}

function writeYesterday(dir, lastNormal, lastAppt) {
  const y = yesterdayKey();
  fs.writeFileSync(path.join(dir, 'state-' + y + '.json'), JSON.stringify({
    date: y, version: 9, nextId: 3, lastNormal: lastNormal, lastUrgent: 2, lastAppt: lastAppt,
    served: { appointment: 0, normal: 0 }, cyclePos: 0,
    tokens: [{
      id: 1, kind: 'normal', number: 1, label: '1', name: '', status: 'done',
      room: 1, createdAt: Date.now() - 9e6, calledAt: Date.now() - 8e6, doneAt: Date.now() - 7e6
    }],
    rooms: [{ id: 1, tokenId: null }], paused: false
  }, null, 2));
  return y;
}

async function testNewMorning() {
  console.log('\na new morning');
  const dir = dataDir('morning'), port = portCounter++;
  writeConfig(dir, baseConfig({ startNumber: 1, resetDaily: true }));
  const y = writeYesterday(dir, 47, 12);
  const p = await start(dir, port);

  check('the day starts again from the first number',
    (await api.post(port, '/api/token', { kind: 'normal' })).token.label, '1');
  check('the booked series restarts too',
    (await api.post(port, '/api/token', { kind: 'appointment' })).token.label, 'A1');
  ok('yesterday was archived to a spreadsheet even though the PC was off',
    fs.existsSync(path.join(dir, 'archive', y + '.csv')));

  await stop(p);
}

async function testContinuousNumbering() {
  console.log('\ncontinuous numbering (daily reset switched off)');
  const dir = dataDir('continuous'), port = portCounter++;
  writeConfig(dir, baseConfig({ resetDaily: false }));
  writeYesterday(dir, 47, 12);
  const p = await start(dir, port);

  check('walk-in numbering carries across the night',
    (await api.post(port, '/api/token', { kind: 'normal' })).token.label, '48');
  check('so does the booked series',
    (await api.post(port, '/api/token', { kind: 'appointment' })).token.label, 'A13');

  await stop(p);
}

async function testCorrections() {
  console.log('\nfixing mistakes');
  const dir = dataDir('undo'), port = portCounter++;
  writeConfig(dir, baseConfig());
  const p = await start(dir, port);

  await api.post(port, '/api/token', { kind: 'normal' });   // goes into room 1
  await api.post(port, '/api/token', { kind: 'normal' });
  const wrong = await api.post(port, '/api/token', { kind: 'urgent' });
  check('the wrong button gave an urgent number', wrong.token.label, 'E1');

  let s = (await api.post(port, '/api/undo', {})).state;
  check('undo removes it again', labels(s), ['2']);

  const missing = (await api.get(port, '/api/state')).rooms[0].token.id;
  s = (await api.post(port, '/api/skip', { id: missing })).state;
  check('a patient who did not answer frees the room', inRooms(s), ['2']);
  check('and is set aside rather than lost', s.skipped.map(t => t.label), ['1']);

  s = (await api.post(port, '/api/recall', { id: missing })).state;
  check('recalling puts them back in the queue', labels(s), ['1']);
  check('nobody is left in the did-not-answer list', s.skipped.length, 0);

  await stop(p);
}

async function testVipReserve() {
  console.log('\nreserving a room for a VIP');
  const dir = dataDir('vip'), port = portCounter++;
  writeConfig(dir, baseConfig({
    rooms: [
      { id: 1, name: 'Room 1', nameHi: 'कक्ष 1', color: '#0B6E77' },
      { id: 2, name: 'Room 2', nameHi: 'कक्ष 2', color: '#2C4A9A' }
    ]
  }));
  let p = await start(dir, port);

  let s = (await api.post(port, '/api/reserve', { room: 1, reserved: true })).state;
  ok('the room shows as reserved', s.rooms[0].reserved);

  await api.post(port, '/api/token', { kind: 'normal' });
  s = (await api.post(port, '/api/token', { kind: 'normal' })).state;
  check('patients go around the reserved room', inRooms(s), [null, '1']);
  check('the second patient waits outside instead', labels(s), ['2']);

  s = (await api.post(port, '/api/call', { room: 1 })).state;
  check('a manual call cannot fill it either', inRooms(s), [null, '1']);

  await stop(p, true);                       // power cut
  p = await start(dir, port);
  s = await api.get(port, '/api/state');
  ok('the reservation survives a power cut', s.rooms[0].reserved);

  s = (await api.post(port, '/api/reserve', { room: 1, reserved: false })).state;
  check('releasing the room lets the queue flow in', inRooms(s), ['2', '1']);

  // an occupied room can be reserved: the patient inside finishes normally,
  // then the room is left empty for the VIP
  await api.post(port, '/api/token', { kind: 'normal' });
  s = (await api.post(port, '/api/reserve', { room: 2, reserved: true })).state;
  check('the patient inside is not disturbed', inRooms(s), ['2', '1']);
  s = (await api.post(port, '/api/done', { room: 2 })).state;
  check('after that patient the room stays empty', inRooms(s), ['2', null]);
  check('the queue keeps waiting for the other room', labels(s), ['3']);

  await stop(p);
}

async function testServices() {
  console.log('\na test room (X-ray) with its own queue');
  const dir = dataDir('services'), port = portCounter++;
  writeConfig(dir, baseConfig({
    services: [{ id: 1, name: 'X-ray', nameHi: 'एक्स-रे', prefix: 'X', color: '#334455' }]
  }));
  let p = await start(dir, port);

  // before seeing the doctor: reception issues an X-ray number directly
  let r = await api.post(port, '/api/token', { kind: 'service', service: 1 });
  check('the first X-ray number is X1', r.token.label, 'X1');
  check('and it is called straight in', r.state.services[0].token.label, 'X1');
  let s = (await api.post(port, '/api/token', { kind: 'service', service: 1 })).state;
  check('the second waits its turn at the test room', s.services[0].next, ['X2']);

  s = (await api.post(port, '/api/token', { kind: 'normal' })).state;
  check('the doctor queue is not disturbed', inRooms(s), ['1']);
  check('and does not count X-ray patients as waiting', s.stats.waiting, 0);

  s = (await api.post(port, '/api/service-done', { service: 1 })).state;
  check('finishing X1 pulls X2 in', s.services[0].token.label, 'X2');

  // after the doctor asks for it: the same call, made from the doctor screen
  r = await api.post(port, '/api/token', { kind: 'service', service: 1 });
  check('the doctor can send a patient for a test the same way', r.token.label, 'X3');

  await stop(p, true);                          // power cut
  p = await start(dir, port);
  s = await api.get(port, '/api/state');
  check('the test room survives a power cut mid-scan', s.services[0].token.label, 'X2');
  check('with its queue intact', s.services[0].next, ['X3']);

  const x2 = s.services[0].token.id;
  s = (await api.post(port, '/api/skip', { id: x2 })).state;
  check('a no-show frees the test room for the next patient', s.services[0].token.label, 'X3');
  s = (await api.post(port, '/api/recall', { id: x2 })).state;
  check('and can be called again later', s.services[0].next, ['X2']);

  s = (await api.post(port, '/api/pause', { paused: true })).state;
  s = (await api.post(port, '/api/service-done', { service: 1 })).state;
  check('the X-ray keeps working through the doctor\'s break', s.services[0].token.label, 'X2');

  const unknown = await api.post(port, '/api/token', { kind: 'service', service: 99 });
  check('an unknown test room is refused', unknown.ok, false);

  await stop(p);
}

async function testReturnFromTest() {
  console.log('\nback from the X-ray, the doctor sees them next');
  const dir = dataDir('return'), port = portCounter++;
  writeConfig(dir, baseConfig({
    services: [{ id: 1, name: 'X-ray', nameHi: 'एक्स-रे', prefix: 'X', color: '#334455' }]
  }));
  const p = await start(dir, port);

  for (let i = 0; i < 3; i++) await api.post(port, '/api/token', { kind: 'normal' });
  let s = await api.get(port, '/api/state');
  check('patient 1 is with the doctor', inRooms(s), ['1']);

  const r = await api.post(port, '/api/send-test', { room: 1, service: 1 });
  check('sending for a test issues a linked number', r.token.label, 'X1');
  s = r.state;
  check('the freed room moves on to the next patient', inRooms(s), ['2']);
  check('the X-ray calls the sent patient straight in', s.services[0].token.label, 'X1');

  s = (await api.post(port, '/api/service-done', { service: 1 })).state;
  check('back from the X-ray they head the queue', labels(s), ['1', '3']);
  ok('and the screen can say why', s.waiting[0].returning && s.waiting[0].returnedFrom === 'X-ray');

  s = (await api.post(port, '/api/done', { room: 1 })).state;
  check('so the doctor sees the returning patient next', inRooms(s), ['1']);
  check('a finished patient reports their start-to-finish time', s.recentDone[0].totalMin, 0);
  check('and the day has an average journey time', s.stats.avgVisit, 0);

  // a plain test visit with no doctor attached just ends
  await api.post(port, '/api/token', { kind: 'service', service: 1 });
  s = (await api.post(port, '/api/service-done', { service: 1 })).state;
  check('a walk-in test does not join the doctor queue', labels(s), ['3']);

  const bad = await api.post(port, '/api/send-test', { room: 1, service: 9 });
  check('sending to an unknown test room is refused', bad.ok, false);

  await stop(p);
}

async function testPages() {
  console.log('\nevery screen and endpoint responds');
  const dir = dataDir('pages'), port = portCounter++;
  writeConfig(dir, baseConfig());
  const p = await start(dir, port);

  for (const u of ['/', '/display', '/doctor', '/settings',
                   '/app.css', '/common.js', '/icon.png', '/api/state', '/api/config', '/api/report.csv']) {
    const r = await fetch('http://127.0.0.1:' + port + u);
    check('GET ' + u, r.status, 200);
  }
  const csv = await (await fetch('http://127.0.0.1:' + port + '/api/report.csv')).text();
  ok('the report carries per-patient total time', csv.includes('total_minutes'));

  let s = await api.get(port, '/api/state');
  ok('the standard quotes ship enabled', s.quotesEnabled && s.quotes.length === 10);
  await api.post(port, '/api/config', {
    pin: '1234',
    config: { quotesEnabled: false, quotes: [{ hi: 'क', en: 'a' }, { hi: '', en: '' }] }
  });
  s = await api.get(port, '/api/state');
  ok('quotes can be switched off and edited in Settings',
    s.quotesEnabled === false && s.quotes.length === 1 && s.quotes[0].en === 'a');

  const bad = await fetch('http://127.0.0.1:' + port + '/../server.js');
  ok('the server does not serve files outside public/', bad.status >= 400);

  const wrongPin = await api.post(port, '/api/config', { pin: '9999', config: { clinicName: 'X' } });
  check('settings are refused without the right PIN', wrongPin.ok, false);

  await stop(p);
}

function testQr() {
  console.log('\nthe QR code printed on the console');
  const { qrMatrix } = require('./qr');
  const url = 'http://192.168.1.23:8080/doctor';
  const m = qrMatrix(url);
  const s = m.length;

  ok('the matrix is square with a valid version size',
    (s - 17) % 4 === 0 && m.every(row => row.length === s));
  ok('finder patterns sit in three corners',
    m[0][0] === 1 && m[0][s - 1] === 1 && m[s - 1][0] === 1 &&
    m[1][1] === 0 && m[3][3] === 1);
  ok('the timing pattern alternates',
    m[6][8] === 1 && m[6][9] === 0 && m[8][6] === 1 && m[9][6] === 0);

  // read the format info back and validate its BCH remainder and level
  let fmt = 0;
  for (let i = 0; i <= 5; i++) fmt |= m[i][8] << i;
  fmt |= m[7][8] << 6; fmt |= m[8][8] << 7; fmt |= m[8][7] << 8;
  for (let i = 9; i <= 14; i++) fmt |= m[8][14 - i] << i;
  const unmasked = fmt ^ 0x5412;
  const fdata = unmasked >>> 10;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  check('the format info self-checks', (unmasked & 0x3FF), rem & 0x3FF);
  check('error-correction level is L', fdata >>> 3, 1);

  // independent read-back: rebuild the function-module map, unmask, unzigzag,
  // and the payload bytes must spell the URL again
  const mask = fdata & 7;
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ];
  const fun = Array.from({ length: s }, () => new Array(s).fill(false));
  const markSquare = (cr, cc, rad) => {
    for (let dr = -rad; dr <= rad; dr++)
      for (let dc = -rad; dc <= rad; dc++) {
        const r = cr + dr, c = cc + dc;
        if (r >= 0 && c >= 0 && r < s && c < s) fun[r][c] = true;
      }
  };
  markSquare(3, 3, 4); markSquare(3, s - 4, 4); markSquare(s - 4, 3, 4);
  const version = (s - 17) / 4;
  if (version >= 2) markSquare(4 * version + 10, 4 * version + 10, 2);
  for (let i = 0; i < s; i++) { fun[6][i] = true; fun[i][6] = true; }
  for (let i = 0; i <= 8; i++) { fun[i][8] = true; fun[8][i] = true; }
  for (let i = 0; i < 8; i++) { fun[8][s - 1 - i] = true; fun[s - 8 + i][8] = true; }

  const bits = [];
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? s - 1 - vert : vert;
        if (!fun[r][c]) bits.push(m[r][c] ^ (MASKS[mask](r, c) ? 1 : 0));
      }
    }
  }
  const byteAt = i => parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2);
  const modeAndLen = byteAt(0) >> 4 === 4 ? ((byteAt(0) & 0x0F) << 4) | (byteAt(1) >> 4) : -1;
  check('the payload announces byte mode and the right length', modeAndLen, url.length);
  let text = '';
  for (let i = 0; i < url.length; i++) {
    text += String.fromCharCode(((byteAt(1 + i) & 0x0F) << 4) | (byteAt(2 + i) >> 4));
  }
  check('the payload spells the doctor URL', text, url);
}

/* ---------- run ---------- */

(async () => {
  const started = Date.now();
  try {
    await testNumbering();
    await testAutoAssignAndUrgent();
    await testPolicies();
    await testPatternResumes();
    await testPowerCut();
    await testNewMorning();
    await testContinuousNumbering();
    await testCorrections();
    await testVipReserve();
    await testServices();
    await testReturnFromTest();
    await testPages();
    testQr();
  } catch (err) {
    failed++;
    failures.push('harness: ' + err.message);
    console.error('\nharness error: ' + err.stack);
  }

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed  (' +
    ((Date.now() - started) / 1000).toFixed(1) + 's)');
  if (failures.length) console.log('failed: ' + failures.join('; '));

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})();
