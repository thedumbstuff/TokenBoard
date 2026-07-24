/* Shared browser helpers for all TokenBoard screens. */

const CQ = {
  state: null,
  _lastVersion: -1,
  _handlers: [],

  onState(fn) { this._handlers.push(fn); },

  _emit() {
    for (const fn of this._handlers) {
      try { fn(this.state); } catch (e) { console.error(e); }
    }
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await res.json();
    if (data && data.state) {
      this.state = data.state;
      this._lastVersion = data.state.version;
      this._emit();
    }
    return data;
  },

  async refresh() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const s = await res.json();
      this.setOnline(true);
      if (s.version !== this._lastVersion) {
        this._lastVersion = s.version;
        this.state = s;
        this._emit();
      }
    } catch (e) {
      this.setOnline(false);
    }
  },

  setOnline(ok) {
    let bar = document.getElementById('cq-offline');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cq-offline';
      bar.textContent = 'Not connected to the clinic system \u2014 check the black window is still open';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#C0272D;color:#fff;' +
        'padding:12px;text-align:center;font-weight:600;font-size:16px;z-index:99;display:none';
      document.body.appendChild(bar);
    }
    bar.style.display = ok ? 'none' : 'block';
  },

  start(intervalMs) {
    this.refresh();
    setInterval(() => this.refresh(), intervalMs || 1500);
  },

  clock(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toLocaleTimeString('en-IN',
        { hour: '2-digit', minute: '2-digit', hour12: true });
    };
    tick();
    setInterval(tick, 10000);
  },

  waitedMinutes(sinceMs) {
    if (!sinceMs) return '';
    const m = Math.floor((Date.now() - sinceMs) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  },

  /* short chime built in code, so no sound file is needed offline */
  chime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this._ctx = this._ctx || new Ctx();
      const ctx = this._ctx;
      if (ctx.state === 'suspended') ctx.resume();
      [880, 1174.7].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = ctx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.5);
      });
    } catch (e) { /* audio is a nicety, never fatal */ }
  },

  speak(text, lang) {
    try {
      if (!window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang || 'en-IN';
      u.rate = 0.85;
      u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }
};

/* Digits spoken one by one are far easier to catch across a noisy room:
   "one zero five" rather than "one hundred and five". */
CQ.spellOut = function (label) {
  return String(label).split('').join(' ');
};

/* Shared rendering helpers for the three token series.
   The letter in front of the number is the primary signal; colour is a
   faster secondary cue that also survives a black-and-white printout. */
function kindCls(t) {
  if (!t) return '';
  if (t.kind === 'urgent') return ' is-urgent';
  if (t.kind === 'appointment') return ' is-appt';
  return '';
}

function kindTag(t) {
  if (!t) return '';
  if (t.kind === 'urgent') return '<span class="tag">Urgent</span>';
  if (t.kind === 'appointment') return '<span class="tag is-appt">Booked</span>';
  return '';
}
