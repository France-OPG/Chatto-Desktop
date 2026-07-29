/* ==========================================================================
   Chatto Enhancer
   1. Per-participant volume sliders on the call panel
   2. Emoji picker next to the send button

   Everything here is additive: it only reads Chatto's DOM and appends its own
   nodes. Nothing Chatto renders is modified or removed, so if a Chatto update
   changes the markup the worst case is that these controls stop appearing —
   not that the app breaks.
   ========================================================================== */
(() => {
  'use strict';

  const SEL = {
    card: '[data-testid="call-participant-card"]',
    list: '[data-testid="call-participants-list"]',
    input: '[data-testid="message-input"]',
    send: 'button[aria-label="Send message"]',
  };

  const log = (...a) => console.log('%c[Chatto Enhancer]', 'color:#2f9bf5;font-weight:600', ...a);

  /* Where the scroll wheel changes volume.
     'card'   — anywhere over a participant (default, fewest movements)
     'slider' — only over the bar itself
     Switch to 'slider' if you ever have enough people in a call that the
     participant list needs scrolling, since 'card' swallows the wheel. */
  const WHEEL_TARGET = 'card';

  /* ---------------------------------------------------------------- state -- */

  let volumes = {};   // { participantName: 0..1 }
  let recents = [];   // most-recently-used emoji characters
  let ready = false;

  chrome.storage.local.get(['volumes', 'recents'], (r) => {
    volumes = r.volumes || {};
    recents = r.recents || [];
    ready = true;
    document.querySelectorAll(SEL.card).forEach(paintCard);
  });

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ volumes, recents });
      } catch (e) {
        /* extension context can go away on reload; nothing to do */
      }
    }, 250);
  }

  /* =========================================================================
     PART 1 — VOLUME
     ========================================================================= */

  /** Our own display name, so we don't put a volume slider on our own card. */
  function localUserName() {
    const el = document.querySelector('[data-testid="current-user-identity-text"]');
    const first = el && el.firstElementChild;
    return first ? first.textContent.trim() : null;
  }

  /** Chatto swaps the panel testid depending on whether you've joined:
      call-observer-panel when watching, call-participant-panel when in it.
      Sliders are meaningless until you're actually in the call. */
  function inCall() {
    return !!document.querySelector('[data-testid="call-participant-panel"]');
  }

  function nameOf(card) {
    const t = (card.getAttribute('title') || '').trim();
    if (t) return t;
    const span = card.querySelector('span');
    return (span && span.textContent.trim()) || 'unknown';
  }

  const getVol = (name) => (name in volumes ? volumes[name] : 1);

  /**
   * Applies every stored volume. Runs on a timer as well as on DOM changes,
   * because LiveKit can swap an audio element out underneath us (on
   * reconnect, or when someone toggles their mic) and a fresh element always
   * starts at full volume.
   */
  /* --- Talking to the page ------------------------------------------------
     Chatto calls LiveKit's track.attach() with no argument, so the <audio>
     elements that actually carry voice are never put in the document. They
     can't be reached from here at all. main-world.js runs inside the page,
     catches them as they're created, and applies our factor to every volume
     write. This side just tells it what the factors should be. */

  const CHANNEL_OUT = 'ce-iso';
  const CHANNEL_IN = 'ce-main';

  let audioIds = [];        // element ids, best known ordering
  let mapping = {};         // participant name -> audio element id
  let orderConfirmed = false;  // have we seen a full sweep yet?
  let pageReady = false;

  const send = (type, payload) => {
    try { window.postMessage({ source: CHANNEL_OUT, type, payload }, '*'); } catch (_) {}
  };

  window.addEventListener('message', (e) => {
    // Deliberately not checking e.source: the two halves of this extension
    // live in different JS worlds and the identity check is unreliable across
    // them. The channel marker below is what actually distinguishes our
    // messages, and this is a same-page channel, not a trust boundary.
    const d = e.data;
    if (!d || d.source !== CHANNEL_IN) return;

    if (d.type === 'ready') {
      pageReady = true;
    } else if (d.type === 'audio') {
      pageReady = true;
    } else if (d.type === 'elements') {
      // The set of live elements changed (someone joined or left). Creation
      // order is a reasonable first guess, so sliders work immediately; a
      // full sweep will confirm or correct it.
      if (!orderConfirmed || d.payload.ids.length !== audioIds.length) {
        audioIds = d.payload.ids;
        orderConfirmed = false;
        remap();
      }
    } else if (d.type === 'order') {
      // Only a sweep that touched every live element tells us the ordering.
      // Chatto also adjusts one participant at a time (local mute), and
      // treating that as the ordering would collapse the mapping to one
      // person.
      if (!d.payload.complete) return;
      audioIds = d.payload.ids;
      orderConfirmed = true;
      remap();
    } else if (d.type === 'levels') {
      learnFromVoice(d.payload.levels);
    } else if (d.type === 'state') {
      window.__ceLastLive = d.payload.live || [];
      if (window.__ceDebugOn) {
        log('page audio elements:', d.payload.elements);
        log('mapping:', mapping);
      }
    }
  });

  /** Remote participant cards, in DOM order, excluding ourselves. */
  function remoteCards() {
    const me = localUserName();
    return [...document.querySelectorAll(SEL.card)]
      .filter((c) => nameOf(c) !== me);
  }

  function remap() {
    const cards = remoteCards();
    const next = {};
    // Pair them off in order. If the counts disagree we only trust the
    // overlap rather than guessing.
    const n = Math.min(cards.length, audioIds.length);
    for (let i = 0; i < n; i++) next[nameOf(cards[i])] = audioIds[i];
    mapping = next;
    window.__ceMapping = mapping;
    if (window.__ceDebugOn) {
      log('remap:', cards.length, 'people,', audioIds.length, 'streams,',
          orderConfirmed ? 'confirmed' : 'provisional', mapping);
    }
    applyVolumes();
  }

  /* --- learning who is who from their voice -------------------------------
     Chatto marks the speaking participant on the card itself
     (data-call-speaking, set from LiveKit's audioLevel). When exactly one
     person is shown speaking and exactly one stream has sound in it, those
     two belong together. A few agreements in a row and we treat it as
     settled — this is independent of ordering or of how many cards there
     are, so it survives someone joining without a microphone. */

  const voiceScore = {};        // name -> { elementId: agreements }
  const VOICE_CONFIRM = 3;
  const SOUND_FLOOR = 0.02;

  function learnFromVoice(levels) {
    const speaking = remoteCards().filter((c) => c.dataset.callSpeaking === 'true');
    if (speaking.length !== 1) return;

    const loud = Object.keys(levels).filter((id) => levels[id] > SOUND_FLOOR);
    if (loud.length !== 1) return;

    const name = nameOf(speaking[0]);
    const id = loud[0];
    if (mapping[name] === id) return;      // already known

    const s = (voiceScore[name] = voiceScore[name] || {});
    s[id] = (s[id] || 0) + 1;
    if (s[id] < VOICE_CONFIRM) return;

    // Settled. Take the stream off anyone it was wrongly assigned to.
    for (const other of Object.keys(mapping)) {
      if (mapping[other] === id) delete mapping[other];
    }
    mapping[name] = id;
    orderConfirmed = true;
    log('matched ' + name + ' to their voice');
    window.__ceMapping = mapping;
    applyVolumes();
  }

  /** Element id for a card: the learned mapping, else its position. */
  function idForCard(card) {
    const name = nameOf(card);
    if (mapping[name]) return mapping[name];
    const i = remoteCards().indexOf(card);
    return i >= 0 && i < audioIds.length ? audioIds[i] : null;
  }

  function applyVolumes() {
    for (const [name, id] of Object.entries(mapping)) {
      send('set', { id, factor: name in volumes ? volumes[name] : 1 });
    }
  }

  function paintCard(card) {
    const wrap = card.querySelector('.ce-vol');
    if (!wrap) return;
    const v = getVol(nameOf(card));
    const pct = Math.round(v * 100);
    wrap.querySelector('.ce-vol-fill').style.width = pct + '%';
    wrap.querySelector('.ce-vol-knob').style.left = pct + '%';
    wrap.querySelector('.ce-vol-badge').textContent = pct === 0 ? 'Muted' : pct + '%';
    wrap.classList.toggle('ce-muted', pct === 0);
    wrap.setAttribute('aria-valuenow', String(pct));
  }

  function setVol(card, v) {
    // Round to whole percent: the wheel steps by 0.05/0.01 repeatedly and
    // binary floats drift (0.30000000000000004), which then shows up in
    // storage and in the badge.
    v = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
    const name = nameOf(card);
    volumes[name] = v;
    paintCard(card);
    const id = idForCard(card);
    if (id) send('set', { id, factor: v });
    else log('no audio stream matched to ' + name + ' yet — run __ceDebug() if this persists.');
    saveSoon();
  }

  function addSlider(card) {
    if (card.querySelector('.ce-vol')) return;
    if (!inCall()) return;                        // not joined yet
    if (nameOf(card) === localUserName()) return; // that's us
    card.classList.add('ce-card');

    const wrap = document.createElement('div');
    wrap.className = 'ce-vol';
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', 'Volume for ' + nameOf(card));
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '100');
    wrap.title = 'Scroll or drag to set volume · double-click to reset';
    wrap.innerHTML =
      '<div class="ce-vol-badge">100%</div>' +
      '<div class="ce-vol-track"><div class="ce-vol-fill"></div><div class="ce-vol-knob"></div></div>';
    card.appendChild(wrap);

    const track = wrap.querySelector('.ce-vol-track');
    const fromX = (clientX) => {
      const r = track.getBoundingClientRect();
      return r.width ? (clientX - r.left) / r.width : 0;
    };

    // Drag anywhere along the bar.
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      track.setPointerCapture(e.pointerId);
      wrap.classList.add('ce-dragging');
      setVol(card, fromX(e.clientX));
    });
    track.addEventListener('pointermove', (e) => {
      if (!wrap.classList.contains('ce-dragging')) return;
      e.preventDefault();
      setVol(card, fromX(e.clientX));
    });
    const endDrag = (e) => {
      if (!wrap.classList.contains('ce-dragging')) return;
      wrap.classList.remove('ce-dragging');
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    // Double-click resets to full, which is quicker than dragging back.
    track.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setVol(card, 1);
    });

    // Scroll wheel. passive:false so the call panel doesn't scroll at the
    // same time as the volume changes.
    (WHEEL_TARGET === 'slider' ? wrap : card).addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 0.01 : 0.05;
      setVol(card, getVol(nameOf(card)) + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    // Keyboard access once the bar has focus.
    wrap.tabIndex = 0;
    wrap.addEventListener('keydown', (e) => {
      const cur = getVol(nameOf(card));
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setVol(card, cur + 0.05); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setVol(card, cur - 0.05); e.preventDefault(); }
      else if (e.key === 'Home') { setVol(card, 0); e.preventDefault(); }
      else if (e.key === 'End') { setVol(card, 1); e.preventDefault(); }
    });

    if (ready) paintCard(card);
  }

  /* =========================================================================
     PART 2 — EMOJI PICKER
     ========================================================================= */

  const GROUPS = window.__CHATTO_EMOJI__ || [];

  const SMILEY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/>
    <path d="M9 9.5h.01M15 9.5h.01"/>
  </svg>`;

  let picker = null;
  let savedRange = null;

  // Track the caret inside the composer continuously, so clicking the picker
  // (which blurs the editor) doesn't lose the insertion point.
  document.addEventListener('selectionchange', () => {
    const inp = document.querySelector(SEL.input);
    if (!inp) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && inp.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  /**
   * Chatto's composer is TipTap/ProseMirror, which keeps its own document
   * model — writing to the DOM directly would desync it. execCommand and the
   * synthetic paste both go through ProseMirror's own input handling, so the
   * editor stays consistent and the send button enables correctly.
   */
  function insertEmoji(ch) {
    const inp = document.querySelector(SEL.input);
    if (!inp) return false;

    inp.focus();
    const sel = window.getSelection();
    if (savedRange && inp.contains(savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    } else {
      const r = document.createRange();
      r.selectNodeContents(inp);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    // 1. execCommand — what ProseMirror handles most cleanly.
    let ok = false;
    try { ok = document.execCommand('insertText', false, ch); } catch (_) {}

    // 2. Synthetic paste — also routed through ProseMirror's input handling.
    if (!ok) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', ch);
        ok = !inp.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }));
      } catch (_) {}
    }

    // 3. Last resort: write the text node ourselves and let ProseMirror's own
    // DOM observer reconcile it. Only reached if both APIs above are missing
    // or blocked, which shouldn't happen in Chromium.
    if (!ok) {
      try {
        const r = sel.rangeCount ? sel.getRangeAt(0) : null;
        if (r) {
          r.deleteContents();
          const node = document.createTextNode(ch);
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          ok = true;
        }
      } catch (_) {}
    }

    if (!ok) log('could not insert the emoji into the composer — please report this.');

    const s2 = window.getSelection();
    if (s2 && s2.rangeCount && inp.contains(s2.anchorNode)) {
      savedRange = s2.getRangeAt(0).cloneRange();
    }

    // Update recents regardless of whether the insertion succeeded. The user
    // clearly wanted this emoji; if the insertion path failed silently they
    // can try again, but the recent list should still reflect their intent.
    recents = [ch, ...recents.filter((c) => c !== ch)].slice(0, 27);
    saveSoon();
    return ok;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  const cell = (ch, name) =>
    `<button class="ce-em" type="button" data-e="${esc(ch)}" data-n="${esc(name)}" title="${esc(name)}">${ch}</button>`;

  function sectionsHTML(query) {
    const q = query.trim().toLowerCase();
    let html = '';

    if (!q && recents.length) {
      html += '<div class="ce-sec" data-sec="recent"><div class="ce-sec-title">Recently used</div>' +
        '<div class="ce-sec-grid">' + recents.map((c) => cell(c, 'recently used')).join('') +
        '</div></div>';
    }

    for (const g of GROUPS) {
      const list = q ? g.e.filter(([, n]) => n.includes(q)) : g.e;
      if (!list.length) continue;
      html += `<div class="ce-sec" data-sec="${esc(g.s)}"><div class="ce-sec-title">${esc(g.n)}</div>` +
        '<div class="ce-sec-grid">' + list.map(([c, n]) => cell(c, n)).join('') +
        '</div></div>';
    }

    return html || '<div class="ce-pick-empty">No emoji matches that search.</div>';
  }

  function buildPicker() {
    const el = document.createElement('div');
    el.className = 'ce-pick';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Emoji picker');
    el.innerHTML =
      '<div class="ce-pick-tabs">' +
        GROUPS.map((g, i) =>
          `<button class="ce-tab${i === 0 ? ' ce-tab-on' : ''}" type="button" data-go="${esc(g.s)}" title="${esc(g.n)}">${g.i}</button>`
        ).join('') +
      '</div>' +
      '<div class="ce-pick-search"><input type="text" placeholder="Search emoji" spellcheck="false"></div>' +
      '<div class="ce-pick-body">' + sectionsHTML('') + '</div>' +
      '<div class="ce-pick-foot"><span class="ce-foot-em">🙂</span><span class="ce-foot-name">Pick an emoji</span></div>';

    const body = el.querySelector('.ce-pick-body');
    const footEm = el.querySelector('.ce-foot-em');
    const footName = el.querySelector('.ce-foot-name');
    const search = el.querySelector('.ce-pick-search input');

    // Keep focus in the editor when clicking an emoji.
    body.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ce-em')) e.preventDefault();
    });

    body.addEventListener('click', (e) => {
      const b = e.target.closest('.ce-em');
      if (!b) return;
      insertEmoji(b.dataset.e);
      // Shift-click to keep going without reopening.
      if (!e.shiftKey) closePicker();
    });

    body.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.ce-em');
      if (!b) return;
      footEm.textContent = b.dataset.e;
      footName.textContent = b.dataset.n;
    });

    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        body.innerHTML = sectionsHTML(search.value);
        body.scrollTop = 0;
      }, 90);
    });

    el.querySelector('.ce-pick-tabs').addEventListener('click', (e) => {
      const t = e.target.closest('.ce-tab');
      if (!t) return;
      search.value = '';
      body.innerHTML = sectionsHTML('');
      const sec = body.querySelector(`.ce-sec[data-sec="${CSS.escape(t.dataset.go)}"]`);
      if (sec) body.scrollTop = sec.offsetTop - body.offsetTop;
      el.querySelectorAll('.ce-tab').forEach((x) => x.classList.toggle('ce-tab-on', x === t));
    });

    // Highlight the tab for whichever section is in view.
    body.addEventListener('scroll', () => {
      const secs = [...body.querySelectorAll('.ce-sec')];
      let cur = secs[0];
      for (const s of secs) {
        if (s.offsetTop - body.offsetTop <= body.scrollTop + 12) cur = s;
      }
      if (!cur) return;
      el.querySelectorAll('.ce-tab').forEach((x) =>
        x.classList.toggle('ce-tab-on', x.dataset.go === cur.dataset.sec));
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
    });

    return el;
  }

  function place(btn) {
    if (!picker) return;
    const r = btn.getBoundingClientRect();
    const w = picker.offsetWidth || 352;
    const h = picker.offsetHeight || 380;
    let left = Math.min(r.right - w, window.innerWidth - w - 10);
    left = Math.max(10, left);
    let top = r.top - h - 8;
    if (top < 10) top = Math.min(r.bottom + 8, window.innerHeight - h - 10);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }

  function closePicker() {
    if (!picker) return;
    picker.remove();
    picker = null;
    document.querySelectorAll('.ce-emoji-btn').forEach((b) => b.classList.remove('ce-open'));
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', onReflow, true);
    window.removeEventListener('scroll', onReflow, true);
  }

  function onDocDown(e) {
    if (picker && !picker.contains(e.target) && !e.target.closest('.ce-emoji-btn')) closePicker();
  }

  function onReflow() {
    const btn = document.querySelector('.ce-emoji-btn.ce-open');
    if (btn) place(btn);
  }

  function togglePicker(btn) {
    if (picker) { closePicker(); return; }
    picker = buildPicker();
    document.body.appendChild(picker);
    btn.classList.add('ce-open');
    place(btn);
    picker.querySelector('.ce-pick-search input').focus();
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onReflow, true);
    window.addEventListener('scroll', onReflow, true);
  }

  function addEmojiButton() {
    const send = document.querySelector(SEL.send);
    if (!send) return;
    const bar = send.parentElement;
    if (!bar || bar.querySelector('.ce-emoji-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ce-emoji-btn';
    btn.title = 'Emoji';
    btn.setAttribute('aria-label', 'Insert emoji');
    btn.innerHTML = SMILEY;
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep caret
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePicker(btn);
    });
    bar.insertBefore(btn, send);
  }


  /* =========================================================================
     WIRING
     ========================================================================= */

  function scan() {
    if (inCall()) {
      document.querySelectorAll(SEL.card).forEach(addSlider);
    } else {
      // Left the call (or only observing) — take the sliders back off.
      document.querySelectorAll('.ce-vol').forEach((v) => v.remove());
      document.querySelectorAll('.ce-card').forEach((c) => c.classList.remove('ce-card'));
      mapping = {};
      audioIds = [];
    }
    addEmojiButton();
  }

  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(() => { scan(); applyVolumes(); }, 60);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => { scan(); applyVolumes(); }, 1500);
  scan();

  // Diagnostic helper. In DevTools, switch the console context dropdown from
  // "top" to "Chatto Enhancer", then run __ceDebug().
  window.__ceDebug = function () {
    window.__ceDebugOn = !window.__ceDebugOn;
    log('debug logging', window.__ceDebugOn ? 'on' : 'off');
    const cards = [...document.querySelectorAll(SEL.card)];
    const audios = [...document.querySelectorAll('audio')];
    log('participant cards:', [...document.querySelectorAll(SEL.card)].map(nameOf));
    log('<audio> in the document:', audios.length,
        '(expected 0 — Chatto attaches off-DOM, so this number is not a problem)');
    log('in call:', inCall(), '· you are:', localUserName());
    log('page hook ready:', pageReady, '· stream ids:', audioIds,
        '· ordering', orderConfirmed ? 'confirmed by a full sweep' : 'provisional');
    log('name -> element:', mapping);
    log('learned from voice:', voiceScore);
    send('query', {});
    return 'see output above (page element details arrive a moment later)';
  };

  // Emergency revert: put everyone back to full volume.
  window.__ceReset = function () {
    for (const id of audioIds) send('set', { id, factor: 1 });
    volumes = {};
    saveSoon();
    document.querySelectorAll(SEL.card).forEach(paintCard);
    return 'all participants back to 100%';
  };

  log('loaded ·', GROUPS.reduce((a, g) => a + g.e.length, 0), 'emoji ready');
})();
