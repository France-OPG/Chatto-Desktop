/* ==========================================================================
   Chatto Enhancer — page-context hook
   ==========================================================================
   This file runs in the PAGE's JavaScript world, not the extension's isolated
   world. It has to, because of how Chatto plays voice audio.

   In apps/frontend/src/lib/state/server/voiceCall.svelte.ts, on TrackSubscribed
   Chatto calls:

       track.attach();

   with no argument. LiveKit creates an <audio> element internally and never
   inserts it into the document — playback doesn't require that. So the element
   is unreachable from document.querySelectorAll('audio'); it only exists as a
   JS object held by LiveKit.

   The only way to reach it is to be there when it's created. We patch
   document.createElement to catch every <audio>, then replace that element's
   `volume` property with our own accessor:

       real volume = (whatever LiveKit asked for) x (our per-person factor)

   That also survives Chatto re-asserting its own volume. Chatto's
   applyRemoteParticipantAudioVolume() sets 0 or 1 depending on its local-mute
   state, and calls it again on every track event. Because we intercept the
   write rather than fight it afterwards, its 1 becomes our 0.4 and its 0 stays
   0 — Chatto's own mute still wins, which is the correct precedence.

   Identifying which element belongs to whom: Chatto's
   applyAllParticipantAudioVolumes() loops over room.remoteParticipants.values()
   and calls setVolume on each in turn. That produces a burst of volume writes,
   one per participant, in the same order the participant cards are rendered.
   We record the order of that burst and hand it to the isolated world, which
   lines it up against the cards on screen.
   ========================================================================== */
(() => {
  'use strict';

  const CHANNEL_OUT = 'ce-main';   // page  -> extension
  const CHANNEL_IN = 'ce-iso';     // extension -> page

  const nativeVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (!nativeVolume || !nativeVolume.set) return;   // nothing to hook

  const records = [];              // { id, el, base, factor }
  const byId = new Map();
  let seq = 0;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const post = (type, payload) => {
    try { window.postMessage({ source: CHANNEL_OUT, type, payload }, '*'); } catch (_) {}
  };

  /* --- which elements are still carrying someone -------------------------
     Elements stay in `records` after a participant leaves, so anything that
     counts them has to ignore the dead ones. */
  function isLive(rec) {
    try {
      const s = rec.el.srcObject;
      if (!s || typeof s.getAudioTracks !== 'function') return false;
      return s.getAudioTracks().some((t) => t.readyState !== 'ended');
    } catch (_) { return false; }
  }
  const liveRecords = () => records.filter(isLive);

  let announceTimer = null;
  function announce() {
    // srcObject is set just after creation, so wait a beat before reporting.
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      post('elements', { ids: liveRecords().map((r) => r.id) });
    }, 200);
  }

  /* --- burst detection ---------------------------------------------------
     A run of volume writes landing within a few milliseconds is Chatto
     looping over participants. But there are TWO such loops in
     voiceCall.svelte.ts:

       applyAllParticipantAudioVolumes()  — every participant
       applyParticipantAudioVolume(id)    — one participant (local mute)

     Only the first tells us the ordering. The second produces a burst of
     length one, and taking that as the ordering collapses the mapping to a
     single person — which is exactly the bug this replaces. So we mark a
     burst "complete" only when it touched every live element, and the
     extension ignores the rest. */
  let burst = [];
  let burstTimer = null;

  function noteWrite(rec) {
    if (!burst.includes(rec.id)) burst.push(rec.id);
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      const live = liveRecords().length;
      if (burst.length) {
        post('order', { ids: burst.slice(), complete: live > 0 && burst.length >= live });
      }
      burst = [];
    }, 90);
  }

  function apply(rec) {
    try { nativeVolume.set.call(rec.el, clamp(rec.base * rec.factor)); } catch (_) {}
  }

  function hook(el) {
    if (el.__ceHooked) return;
    el.__ceHooked = true;

    const rec = { id: 'a' + (seq++), el, base: 1, factor: 1 };
    records.push(rec);
    byId.set(rec.id, rec);

    Object.defineProperty(el, 'volume', {
      configurable: true,
      enumerable: true,
      // Report back what LiveKit set, so its own bookkeeping stays consistent
      // and it never sees a value it didn't write.
      get() { return rec.base; },
      set(v) {
        const n = Number(v);
        rec.base = Number.isFinite(n) ? clamp(n) : 1;
        noteWrite(rec);
        apply(rec);
      },
    });

    post('audio', { id: rec.id, count: records.length });
    announce();
  }

  const origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, ...rest) {
    const el = origCreateElement.call(this, tagName, ...rest);
    try {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'audio') hook(el);
    } catch (_) {}
    return el;
  };

  // Anything already created before we loaded (shouldn't happen at
  // document_start, but harmless).
  try { document.querySelectorAll('audio').forEach(hook); } catch (_) {}

  /* --- measuring who is actually making noise ----------------------------
     Matching a stream to a person by position is fragile: someone who joined
     without a working microphone has a participant card but no audio stream,
     and every position after them is then off by one. That produces exactly
     the "works sometimes" behaviour.

     So we also measure each stream's loudness. The extension compares that
     against which card Chatto is showing as speaking, and once the two agree
     a few times in a row it knows for certain who is who.

     The analyser is a measuring tap only — it is never connected to the
     output, so it cannot affect what you hear. */
  let ac = null;
  const taps = new Map();   // id -> { src, an, data }

  function audioCtx() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch (_) { return null; }
    return ac;
  }

  function tap(rec) {
    if (taps.has(rec.id)) return taps.get(rec.id);
    const ctx = audioCtx();
    if (!ctx || !rec.el.srcObject) return null;
    try {
      const src = ctx.createMediaStreamSource(rec.el.srcObject);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);            // deliberately NOT connected to destination
      const t = { src, an, data: new Uint8Array(an.frequencyBinCount) };
      taps.set(rec.id, t);
      return t;
    } catch (_) { return null; }
  }

  // An AudioContext may start suspended until the user interacts.
  const wake = () => { const c = audioCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
  window.addEventListener('click', wake, true);
  window.addEventListener('keydown', wake, true);

  setInterval(() => {
    const live = liveRecords();
    if (!live.length) return;
    const levels = {};
    for (const rec of live) {
      const t = tap(rec);
      if (!t) continue;
      t.an.getByteFrequencyData(t.data);
      let sum = 0;
      for (let i = 0; i < t.data.length; i++) sum += t.data[i];
      levels[rec.id] = sum / t.data.length / 255;
    }
    if (Object.keys(levels).length) post('levels', { levels });
  }, 220);

  window.addEventListener('message', (e) => {
    // Deliberately not checking e.source: the two halves of this extension
    // live in different JS worlds and the identity check is unreliable across
    // them. The channel marker below is what actually distinguishes our
    // messages, and this is a same-page channel, not a trust boundary.
    const d = e.data;
    if (!d || d.source !== CHANNEL_IN) return;

    if (d.type === 'set') {
      const rec = byId.get(d.payload.id);
      if (!rec) return;
      rec.factor = clamp(Number(d.payload.factor));
      apply(rec);
    } else if (d.type === 'query') {
      post('state', {
        live: liveRecords().map((r) => r.id),
        elements: records.map((r) => ({
          live: isLive(r),
          id: r.id,
          base: r.base,
          factor: r.factor,
          effective: clamp(r.base * r.factor),
          hasStream: !!r.el.srcObject,
          tracks: (() => {
            try { return r.el.srcObject ? r.el.srcObject.getAudioTracks().length : 0; }
            catch (_) { return 0; }
          })(),
          paused: r.el.paused,
        })),
      });
    }
  });

  post('ready', {});
})();
