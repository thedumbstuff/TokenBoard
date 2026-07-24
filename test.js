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

async function testPages() {
  console.log('\nevery screen and endpoint responds');
  const dir = dataDir('pages'), port = portCounter++;
  writeConfig(dir, baseConfig());
  const p = await start(dir, port);

  for (const u of ['/', '/display', '/doctor', '/settings',
                   '/app.css', '/common.js', '/api/state', '/api/config', '/api/report.csv']) {
    const r = await fetch('http://127.0.0.1:' + port + u);
    check('GET ' + u, r.status, 200);
  }
  const bad = await fetch('http://127.0.0.1:' + port + '/../server.js');
  ok('the server does not serve files outside public/', bad.status >= 400);

  const wrongPin = await api.post(port, '/api/config', { pin: '9999', config: { clinicName: 'X' } });
  check('settings are refused without the right PIN', wrongPin.ok, false);

  await stop(p);
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
    await testPages();
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
