// ===== Noise & Recall Lab — main app (screens, test runner, results) =====

let settings = loadSettings();
let runner = null;                 // the session currently running, if any
const lastCalibrationPlay = {};    // noise type -> { gainDb, targetDb } of the last calibration playback
const resultsState = {
  source: Cloud.enabled ? 'shared' : 'device', // 'shared' = everyone's data, 'device' = this device only
  group: 'all',
  includeDemo: null,
  hidden: new Set(),
};
const shared = { trials: [], loadedAt: 0, loading: null, error: '' }; // cache of the shared database
const sync = { running: null, error: '' };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '–';
}
function fmtSigned(value, digits = 1) {
  return Number.isFinite(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(digits) : '–';
}
function fmtP(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '–';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function normalizeCode(text) {
  return text.trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
}
function normalizeGroup(text) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 40);
}
function topLevel() {
  return Math.max(...settings.noiseLevels);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// Navigation
// ============================================================

const VIEWS = ['run', 'calibrate', 'results', 'guide'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'run';
  for (const view of VIEWS) $('#view-' + view).hidden = view !== name;
  $$('.tab').forEach(tab => tab.setAttribute('aria-current', tab.dataset.view === name ? 'page' : 'false'));
  if (name !== 'calibrate' && !runner && NoiseEngine.ready) NoiseEngine.stop(0.2);
  if (name === 'run') renderRunSetup();
  if (name === 'calibrate') renderCalibration();
  if (name === 'results') renderResults();
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
}

function currentView() {
  return VIEWS.find(view => !$('#view-' + view).hidden);
}

function fillSettingSpans() {
  $$('[data-setting]').forEach(span => {
    const value = settings[span.dataset.setting];
    span.textContent = Array.isArray(value) ? value.join(', ') : value;
  });
}

async function ensureAudio(button) {
  if (NoiseEngine.ready) return NoiseEngine.init();
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'Loading sounds…'; }
  try {
    await NoiseEngine.init();
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

// ============================================================
// Shared database: uploading and downloading
// ============================================================

// Uploads every trial on this device that isn't in the shared database yet.
function syncPending() {
  if (!Cloud.enabled) return Promise.resolve();
  if (sync.running) return sync.running;
  sync.running = (async () => {
    const pending = loadTrials().filter(t => !t.demo && !t.synced);
    if (!pending.length) return;
    try {
      await Cloud.upload(pending);
      markSynced(pending.map(t => t.trialId));
      sync.error = '';
      shared.loadedAt = 0; // shared results are now out of date
    } catch (error) {
      sync.error = error.message || 'offline';
    }
  })().finally(() => {
    sync.running = null;
    renderSyncStatus();
  });
  return sync.running;
}

function renderSyncStatus() {
  const pending = loadTrials().filter(t => !t.demo && !t.synced).length;
  let html;
  if (!Cloud.enabled) {
    html = '<span class="sync off">Shared database is off — results are saved on this device only.</span>';
  } else if (pending) {
    html = `<span class="sync wait">⏳ ${pending} result${pending === 1 ? '' : 's'} waiting to upload${sync.error ? ' (no connection?)' : ''}</span> <button class="btn small" data-sync-now>Retry now</button>`;
  } else {
    html = '<span class="sync ok">☁ All results on this device are saved to the shared database.</span>';
  }
  $$('.sync-status').forEach(el => { el.innerHTML = html; });
}

// Downloads everyone's trials (cached for 15 seconds).
function loadShared(force) {
  if (!Cloud.enabled) return Promise.resolve();
  if (shared.loading) return shared.loading;
  if (!force && Date.now() - shared.loadedAt < 15000) return Promise.resolve();
  shared.loading = (async () => {
    try {
      await syncPending();
      shared.trials = await Cloud.fetchAll();
      shared.loadedAt = Date.now();
      shared.error = '';
    } catch (error) {
      shared.error = error.message || 'Could not reach the shared database';
    }
  })().finally(() => { shared.loading = null; });
  return shared.loading;
}

// Everything this device knows about: shared trials + local trials not uploaded yet.
function knownTrials() {
  const byId = new Map();
  for (const trial of shared.trials) byId.set(trial.trialId, trial);
  for (const trial of loadTrials()) if (!byId.has(trial.trialId)) byId.set(trial.trialId, trial);
  return [...byId.values()];
}

// ============================================================
// Run tab
// ============================================================

function groupMainTrials() {
  const group = settings.groupName;
  return knownTrials().filter(t => t.phase === 'main' && !t.demo && (t.groupName || '') === group);
}

function nextOrderIndex() {
  const participants = new Set(groupMainTrials().map(t => t.participant));
  return participants.size % getConditions(settings).length;
}

function renderRunSetup() {
  fillSettingSpans();
  $('#group-name').value = settings.groupName;
  const conditions = getConditions(settings);
  const select = $('#order-group');
  const previous = select.value || 'auto';
  const next = nextOrderIndex();
  let options = `<option value="auto">Auto — next is order ${orderGroupName(next)}</option>`;
  for (let i = 0; i < conditions.length; i++) {
    options += `<option value="${i}">Order ${orderGroupName(i)}: ${escapeHtml(describeOrder(i, settings))}</option>`;
  }
  select.innerHTML = options;
  select.value = [...select.options].some(o => o.value === previous) ? previous : 'auto';
  updateOrderPreview();

  $('#volume-note-display').textContent = settings.volumeNote || 'not recorded yet (Calibrate tab)';
  renderCalibrationChips();
  renderRecentSessions();
  renderSyncStatus();

  const perParticipant = conditions.length * settings.trialsPerLevel;
  $('#plan-summary').textContent = `${conditions.length} conditions (quiet + ${settings.noiseLevels.length} noise levels) × ${settings.trialsPerLevel} sequences = ${perParticipant} sequences of ${settings.sequenceLength} digits · about ${estimateMinutes()} minutes per participant.`;

  // Refresh the order suggestion once the shared data arrives.
  if (Cloud.enabled) loadShared().then(() => { if (currentView() === 'run') refreshAutoOrder(); });
}

function refreshAutoOrder() {
  const auto = $('#order-group option[value="auto"]');
  if (auto) auto.textContent = `Auto — next is order ${orderGroupName(nextOrderIndex())}`;
  updateOrderPreview();
}

function estimateMinutes() {
  const conditions = getConditions(settings).length;
  const perTrial = settings.leadInSeconds + settings.showSeconds + settings.recallSeconds * 0.8 + 3;
  return Math.round((conditions * settings.trialsPerLevel * perTrial + (conditions - 1) * (settings.breakSeconds + 10)) / 60);
}

function selectedOrderIndex() {
  const value = $('#order-group').value;
  return value === 'auto' ? nextOrderIndex() : Number(value);
}

function updateOrderPreview() {
  const index = selectedOrderIndex();
  $('#order-preview').textContent = `Order ${orderGroupName(index)}: ${describeOrder(index, settings)}`;
  const code = normalizeCode($('#participant-code').value);
  const existing = code ? groupMainTrials().filter(t => t.participant === code).length : 0;
  const warning = $('#duplicate-warning');
  warning.hidden = existing === 0;
  warning.textContent = existing ? `${code} already has ${existing} saved trials in this group. Use a new code for a new person.` : '';
}

function renderCalibrationChips() {
  $('#calibration-status').innerHTML = activeNoiseTypes(settings).map(type => {
    const ok = Boolean(settings.calibration[type]);
    return `<span class="chip ${ok ? 'ok' : 'no'}">${NOISE_INFO[type].label} ${ok ? 'calibrated' : 'not calibrated'}</span>`;
  }).join('');
}

function renderRecentSessions() {
  const sessions = loadSessions().slice(-8).reverse();
  if (!sessions.length) {
    $('#recent-sessions').innerHTML = '<p class="hint">No sessions on this device yet.</p>';
    return;
  }
  const trials = loadTrials();
  const rows = sessions.map(session => {
    const own = trials.filter(t => t.sessionId === session.id);
    const average = own.length ? mean(own.map(t => t.percent)) : NaN;
    const time = new Date(session.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<tr><td>${escapeHtml(session.groupName || '–')}</td><td>${escapeHtml(session.participant)}</td><td>${session.phase === 'pilot' ? 'Pilot' : 'Order ' + escapeHtml(session.orderGroup)}</td>
      <td>${escapeHtml(session.status)}</td><td class="num">${own.length}</td><td class="num">${fmt(average)}%</td><td>${time}</td></tr>`;
  }).join('');
  $('#recent-sessions').innerHTML = `<table><thead><tr><th>Group</th><th>Participant</th><th>Type</th><th>Status</th><th class="num">Trials</th><th class="num">Mean</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pilotLengths() {
  const center = settings.sequenceLength;
  return [center - 4, center - 2, center, center + 2, center + 4].filter(n => n >= 3 && n <= 30);
}

async function onStartSession(isPilot) {
  const button = isPilot ? $('#start-pilot') : $('#start-session');
  settings.groupName = normalizeGroup($('#group-name').value);
  saveSettings(settings);
  const code = normalizeCode($('#participant-code').value) || (isPilot ? 'PILOT' : '');
  if (!settings.groupName && !confirm('No group name entered. Group names keep your P1, P2… separate from other groups. Continue without one?')) {
    $('#group-name').focus();
    return;
  }
  if (!code) {
    alert('Enter a participant code first (for example P1).');
    $('#participant-code').focus();
    return;
  }
  if (!$('#consent').checked) {
    alert('Tick the consent box first. Every participant must give written consent before testing.');
    return;
  }
  if (!isPilot) {
    const existing = groupMainTrials().filter(t => t.participant === code).length;
    if (existing && !confirm(`${code} already has ${existing} saved trials in this group. Test them again anyway?`)) return;
    const missing = activeNoiseTypes(settings).filter(type => !settings.calibration[type]);
    if (missing.length && !confirm(`Not calibrated yet: ${missing.map(t => NOISE_INFO[t].label).join(', ')}.\nThe dB levels will only be a rough guess. Continue anyway?`)) return;
    if (topLevel() > 85 && !confirm(`This test goes up to ${topLevel()} dB(A), which is loud. Make sure the participant knows they can stop at any time. Continue?`)) return;
  }
  await ensureAudio(button);
  const plan = isPilot ? buildPilotPlan(pilotLengths(), 2) : buildSessionPlan(code, selectedOrderIndex(), settings);
  $('#consent').checked = false;
  runSession(plan, code);
}

// ============================================================
// Test runner
// ============================================================

function abortError() {
  return new DOMException('Session stopped', 'AbortError');
}

// Waits ms milliseconds, or stops early if the session is stopped.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(id); reject(abortError()); };
    const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Waits for a button click (or Enter key).
function waitForClick(selector, signal) {
  return new Promise((resolve, reject) => {
    const button = $(selector);
    const cleanup = () => {
      button.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      signal.removeEventListener('abort', onAbort);
    };
    const onClick = () => { cleanup(); resolve(); };
    const onKey = event => { if (event.key === 'Enter') { event.preventDefault(); cleanup(); resolve(); } };
    const onAbort = () => { cleanup(); reject(abortError()); };
    button.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    signal.addEventListener('abort', onAbort, { once: true });
    button.focus();
  });
}

function setStage(html) {
  $('#stage-content').innerHTML = html;
}

function setProgress(text) {
  $('#stage-progress').textContent = text;
}

function startTimerBar(seconds) {
  const bar = $('#stage-content .timer-bar > div');
  if (!bar) return;
  bar.style.transform = 'scaleX(1)';
  void bar.offsetWidth; // forces the browser to apply the start state before animating
  bar.style.transition = `transform ${seconds}s linear`;
  bar.style.transform = 'scaleX(0)';
}

function requestStop() {
  if (!runner) return;
  if (confirm('Stop this session? Trials already finished are saved.')) runner.controller.abort();
}

function makeTrialRecord({ session, plan, block, blockIndex, trialIndex, trialNumber, trial, response, responseMs, gainDb, demo }) {
  const score = scoreResponse(trial.digits, response);
  return {
    trialId: session.id + '-' + String(trialNumber).padStart(2, '0'),
    sessionId: session.id,
    groupName: session.groupName || '',
    participant: session.participant,
    phase: plan.phase,
    orderGroup: plan.orderIndex === null ? '' : orderGroupName(plan.orderIndex),
    block: blockIndex + 1,
    trialInBlock: trialIndex + 1,
    trialNumber,
    condition: block.condition.key,
    noiseType: trial.noiseType,
    intendedDb: block.condition.db,
    gainDb: gainDb === null ? null : Math.round(gainDb * 10) / 10,
    calibrated: trial.noiseType === 'none' ? true : Boolean(settings.calibration[trial.noiseType]),
    sequenceId: trial.sequenceId,
    sequence: trial.digits,
    response,
    correct: score.correct,
    length: trial.digits.length,
    percent: Math.round(score.percent * 100) / 100,
    positionsCorrect: score.positions.map(ok => (ok ? 'Y' : 'N')).join(''),
    responseMs,
    showSeconds: settings.showSeconds,
    recallSeconds: settings.recallSeconds,
    deviceNote: (settings.volumeNote || '').slice(0, 120),
    timestamp: new Date().toISOString(),
    demo: Boolean(demo),
    synced: false,
  };
}

async function runSession(plan, participant) {
  const session = {
    id: newId(),
    groupName: settings.groupName,
    participant,
    phase: plan.phase,
    orderGroup: plan.orderIndex === null ? '' : orderGroupName(plan.orderIndex),
    consent: true,
    startedAt: new Date().toISOString(),
    status: 'running',
    trialsCompleted: 0,
    volumeNote: settings.volumeNote,
  };
  saveSession(session);
  const controller = new AbortController();
  const signal = controller.signal;
  runner = { session, plan, controller };
  $('#stage').hidden = false;
  document.body.classList.add('testing');

  let trialNumber = 0;
  try {
    for (let b = 0; b < plan.blocks.length; b++) {
      const block = plan.blocks[b];
      await blockIntro(plan, b, signal);
      for (let i = 0; i < block.trials.length; i++) {
        trialNumber++;
        setProgress(plan.phase === 'pilot'
          ? `Pilot · sequence ${i + 1} of ${block.trials.length}`
          : `Part ${b + 1} of ${plan.blocks.length} · sequence ${i + 1} of ${block.trials.length}`);
        await runTrial({ session, plan, block, blockIndex: b, trialIndex: i, trialNumber }, signal);
        session.trialsCompleted = trialNumber;
        saveSession(session);
      }
      if (b < plan.blocks.length - 1 && settings.breakSeconds > 0) await breakScreen(signal);
    }
    session.status = 'completed';
    session.endedAt = new Date().toISOString();
    saveSession(session);
    await doneScreen(plan, signal);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      alert('Something went wrong: ' + error.message + '\nFinished trials are saved.');
    }
    if (session.status === 'running') {
      session.status = 'stopped';
      session.endedAt = new Date().toISOString();
      saveSession(session);
    }
  } finally {
    NoiseEngine.stop(0.2);
    runner = null;
    $('#stage').hidden = true;
    document.body.classList.remove('testing');
    syncPending();
    showView(plan.phase === 'pilot' ? 'results' : 'run');
  }
}

async function blockIntro(plan, blockIndex, signal) {
  setProgress(plan.phase === 'pilot' ? 'Pilot' : `Part ${blockIndex + 1} of ${plan.blocks.length}`);
  const first = blockIndex === 0;
  const title = plan.phase === 'pilot' ? 'Pilot test' : first ? 'Welcome!' : `Part ${blockIndex + 1} of ${plan.blocks.length}`;
  const text = first
    ? `A row of digits will appear for <b>${settings.showSeconds} seconds</b>. Try to remember them <b>in order</b>. Then they disappear and you have <b>${settings.recallSeconds} seconds</b> to type them back. You may hear background noise — just ignore it and do your best.<br><br>If you forget a digit, press <b>Skip</b> (or Space) so the others stay in the right place.`
    : 'Ready for the next part? The background sound may be louder or quieter.';
  setStage(`<h2>${title}</h2><p>${text}</p><button id="go" class="btn primary big">Start</button>`);
  await waitForClick('#go', signal);
}

async function runTrial(context, signal) {
  const { block, trialIndex } = context;
  const trial = block.trials[trialIndex];
  let gainDb = null;
  if (trial.noiseType !== 'none') {
    gainDb = NoiseEngine.play(trial.noiseType, block.condition.db, settings.calibration).gainDb;
  }

  setStage('<p class="timer-text">Get ready…</p>');
  await wait(settings.leadInSeconds * 1000, signal);

  // Long sequences shrink so they always fit on one line.
  const size = `min(120px, calc(88vw / ${(trial.digits.length * 0.72).toFixed(2)}))`;
  setStage(`<div class="big-digits" style="font-size:${size}">${escapeHtml(trial.digits)}</div><div class="timer-bar"><div></div></div>`);
  startTimerBar(settings.showSeconds);
  await wait(settings.showSeconds * 1000, signal);

  const { response, responseMs } = await collectRecall(trial.digits.length, settings.recallSeconds, signal);
  NoiseEngine.stop(0.4);
  addTrial(makeTrialRecord({ ...context, trial, response, responseMs, gainDb }));
  syncPending();

  setStage('<p class="timer-text">Saved ✓ Next sequence…</p>');
  await wait(1800, signal);
}

// Shows the answer boxes + keypad and resolves with the typed answer ("_" = skipped digit).
function collectRecall(length, seconds, signal) {
  return new Promise((resolve, reject) => {
    const values = new Array(length).fill('');
    let cursor = 0;
    const started = performance.now();
    const slots = values.map((_, i) => `<div class="slot" data-i="${i}"></div>`).join('');
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => `<button data-k="${d}">${d}</button>`).join('');
    setStage(`
      <h2>Type the digits in order</h2>
      <div class="slots" style="--n:${length}">${slots}</div>
      <div class="timer-bar"><div></div></div>
      <div class="timer-text" id="time-left"></div>
      <div class="keypad">${keys}
        <button class="wide" data-k="back">⌫ Delete</button>
        <button class="wide" data-k="skip">Skip →</button>
        <button class="wide go" data-k="done">Done</button>
      </div>`);
    startTimerBar(seconds);

    const render = () => {
      $$('#stage-content .slot').forEach((slot, i) => {
        slot.textContent = values[i];
        slot.classList.toggle('current', i === cursor);
      });
    };
    const press = key => {
      if (/^[0-9]$/.test(key)) {
        values[cursor] = key;
        if (cursor < length - 1) cursor++;
      } else if (key === 'skip' || key === 'right') {
        if (cursor < length - 1) cursor++;
      } else if (key === 'left') {
        if (cursor > 0) cursor--;
      } else if (key === 'back') {
        if (values[cursor]) values[cursor] = '';
        else if (cursor > 0) { cursor--; values[cursor] = ''; }
      } else if (key === 'done') {
        return finish();
      }
      render();
    };
    const onKey = event => {
      const map = { Backspace: 'back', Delete: 'back', ' ': 'skip', ArrowRight: 'right', ArrowLeft: 'left', Enter: 'done', Tab: 'skip' };
      const key = /^[0-9]$/.test(event.key) ? event.key : map[event.key];
      if (!key) return;
      event.preventDefault();
      press(key);
    };
    const onClick = event => {
      const button = event.target.closest('[data-k]');
      if (button) return press(button.dataset.k);
      const slot = event.target.closest('.slot');
      if (slot) { cursor = Number(slot.dataset.i); render(); }
    };
    const timer = setInterval(() => {
      const left = seconds - (performance.now() - started) / 1000;
      const label = $('#time-left');
      if (label) label.textContent = `${Math.max(0, Math.ceil(left))} s left`;
      if (left <= 0) finish();
    }, 200);
    const cleanup = () => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      $('#stage-content').removeEventListener('click', onClick);
      signal.removeEventListener('abort', onAbort);
    };
    function finish() {
      cleanup();
      resolve({ response: values.map(v => v || '_').join(''), responseMs: Math.round(performance.now() - started) });
    }
    function onAbort() {
      cleanup();
      reject(abortError());
    }
    document.addEventListener('keydown', onKey);
    $('#stage-content').addEventListener('click', onClick);
    signal.addEventListener('abort', onAbort, { once: true });
    $('#time-left').textContent = `${seconds} s left`;
    render();
  });
}

async function breakScreen(signal) {
  setProgress('Break');
  setStage(`<h2>Short break</h2><p>Keep the AirPods in and relax for a moment.</p>
    <div class="countdown-ring" id="break-left">${settings.breakSeconds}</div>
    <button id="skip-break" class="btn small ghost">Skip break (tester only)</button>`);
  const skip = new AbortController();
  $('#skip-break').addEventListener('click', () => skip.abort(), { once: true });
  for (let left = settings.breakSeconds; left > 0 && !skip.signal.aborted; left--) {
    $('#break-left').textContent = left;
    await Promise.race([wait(1000, signal), new Promise(resolve => skip.signal.addEventListener('abort', resolve, { once: true }))]);
  }
}

async function doneScreen(plan, signal) {
  setProgress('Finished');
  if (plan.phase === 'pilot') {
    const pilot = analyzePilot(loadTrials());
    const rows = pilot.rows.map(r => `${r.length} digits: ${fmt(r.stats.mean, 0)}%`).join(' · ');
    setStage(`<h2>Pilot finished</h2><p>${escapeHtml(rows)}</p>
      <p>Suggested length: <b>${pilot.suggestion ? pilot.suggestion.length : '–'} digits</b> (closest to 75% correct in quiet). Set it on the Calibrate &amp; settings tab.</p>
      <button id="finish" class="btn primary big">See results</button>`);
  } else {
    setStage(`<h2>All done — thank you!</h2><p>You've finished every part. You can take the AirPods out now.</p>
      <button id="finish" class="btn primary big">Close</button>`);
  }
  await waitForClick('#finish', signal);
}

// ============================================================
// Calibrate & settings tab
// ============================================================

function renderCalibration() {
  $('#volume-note').value = settings.volumeNote;
  $('#quiet-db').value = settings.quietRoomDb;
  $$('.top-level').forEach(el => { el.textContent = topLevel(); });
  $('#calibration-rows').innerHTML = activeNoiseTypes(settings).map(calibrationRowHtml).join('');
  $('#set-length').value = settings.sequenceLength;
  $('#set-per-level').value = settings.trialsPerLevel;
  $('#set-show').value = settings.showSeconds;
  $('#set-recall').value = settings.recallSeconds;
  $('#set-break').value = settings.breakSeconds;
  $('#set-levels').value = settings.noiseLevels.join(', ');
  $$('[data-noise-type]').forEach(box => { box.checked = activeNoiseTypes(settings).includes(box.dataset.noiseType); });
  const types = activeNoiseTypes(settings);
  $('#settings-summary').textContent = `${getConditions(settings).length * settings.trialsPerLevel} sequences per participant · about ${estimateMinutes()} minutes each.` +
    (types.length > 1 ? ` Each noise type is heard ${fmt(settings.trialsPerLevel / types.length, settings.trialsPerLevel % types.length ? 1 : 0)} times per level.` : '');
  renderSequenceBank();
}

function calibrationRowHtml(type) {
  const info = NOISE_INFO[type];
  const cal = settings.calibration[type];
  let status;
  if (cal) {
    const when = new Date(cal.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    status = `<div class="cal-status ok">Calibrated ${when}: at gain ${fmt(cal.atGainDb)} dB the meter read ${fmt(cal.measuredDb)} dB(A).</div>`;
    if (NoiseEngine.ready && NoiseEngine.gainFor(type, topLevel(), settings.calibration).clipping) {
      status += `<div class="notice bad">${topLevel()} dB needs more than the maximum digital volume for this sound. Turn the device volume up a step and calibrate again.</div>`;
    }
  } else {
    status = '<div class="cal-status no">Not calibrated — levels are a rough guess.</div>';
  }
  const verify = settings.noiseLevels.map(db => {
    const reading = settings.verification[`${type}-${db}`];
    const diff = Number.isFinite(reading) ? ` <span class="hint">(${fmtSigned(reading - db)})</span>` : '';
    return `<span class="verify-item"><button class="btn small" data-act="play" data-db="${db}">▶ ${db}</button>
      <input type="number" step="0.1" data-role="verify" data-db="${db}" placeholder="read" value="${Number.isFinite(reading) ? reading : ''}" aria-label="Measured at ${db} dB">${diff}</span>`;
  }).join('');
  return `<div class="cal-row" data-type="${type}">
    <div class="cal-head"><span class="swatch" style="background:var(--series-${type})"></span><b>${info.label}</b><span class="hint">${info.description}</span></div>
    <div class="cal-controls">
      <button class="btn small" data-act="play" data-db="${topLevel()}">▶ Play at ${topLevel()} dB</button>
      <button class="btn small" data-act="stop">■ Stop</button>
      <span class="hint">Meter reads</span>
      <input type="number" step="0.1" min="20" max="120" data-role="reading" placeholder="dB(A)" aria-label="Meter reading for ${info.label}">
      <button class="btn small primary" data-act="save">Save reading</button>
      ${cal ? '<button class="btn small ghost" data-act="reset">Reset</button>' : ''}
    </div>
    ${status}
    <div class="cal-playing hint" data-role="playing"></div>
    <div class="cal-verify">Physics check — play each level and record the meter: ${verify}</div>
  </div>`;
}

async function onCalibrationClick(event) {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const row = button.closest('.cal-row');
  const type = row.dataset.type;
  const action = button.dataset.act;

  if (action === 'play') {
    await ensureAudio(button);
    const db = Number(button.dataset.db);
    const result = NoiseEngine.play(type, db, settings.calibration);
    lastCalibrationPlay[type] = { gainDb: result.gainDb, targetDb: db };
    $$('[data-role="playing"]').forEach(el => { el.textContent = ''; });
    row.querySelector('[data-role="playing"]').innerHTML =
      `Playing ${NOISE_INFO[type].label.toLowerCase()} for ${db} dB(A) (digital gain ${fmt(result.gainDb)} dB).` +
      (result.clipping ? ' <b>Too quiet to reach this level — turn the device volume up and calibrate again.</b>' : '');
  } else if (action === 'stop') {
    NoiseEngine.stop(0.2);
    row.querySelector('[data-role="playing"]').textContent = '';
  } else if (action === 'save') {
    const reading = Number(row.querySelector('[data-role="reading"]').value);
    const last = lastCalibrationPlay[type];
    if (!last) return alert(`Press "Play at ${topLevel()} dB" for this sound first, then measure it.`);
    if (!Number.isFinite(reading) || reading < 20 || reading > 120) return alert('Enter the meter reading in dB(A), for example 68.5.');
    settings.calibration[type] = { measuredDb: reading, atGainDb: last.gainDb, date: new Date().toISOString() };
    saveSettings(settings);
    NoiseEngine.stop(0.2);
    delete lastCalibrationPlay[type];
    renderCalibration();
  } else if (action === 'reset') {
    if (!confirm(`Reset the calibration for ${NOISE_INFO[type].label}?`)) return;
    settings.calibration[type] = null;
    saveSettings(settings);
    renderCalibration();
  }
}

function onCalibrationInput(event) {
  const input = event.target.closest('[data-role="verify"]');
  if (!input) return;
  const key = `${input.closest('.cal-row').dataset.type}-${input.dataset.db}`;
  const value = parseFloat(input.value);
  if (Number.isFinite(value)) settings.verification[key] = value;
  else delete settings.verification[key];
  saveSettings(settings);
}

function readNumber(selector, min, max, fallback) {
  const value = Number($(selector).value);
  return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
}

function onSaveSettings() {
  const levels = [...new Set($('#set-levels').value.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 20 && n <= MAX_SAFE_DB))].sort((a, b) => a - b);
  if (!levels.length) return alert(`Enter at least one noise level between 20 and ${MAX_SAFE_DB} dB, e.g. 40, 50, 60.`);
  const types = $$('[data-noise-type]').filter(box => box.checked).map(box => box.dataset.noiseType);
  if (!types.length) return alert('Pick at least one noise type.');
  const updated = {
    ...settings,
    sequenceLength: readNumber('#set-length', 3, 30, settings.sequenceLength),
    trialsPerLevel: readNumber('#set-per-level', 1, 15, settings.trialsPerLevel),
    showSeconds: readNumber('#set-show', 2, 60, settings.showSeconds),
    recallSeconds: readNumber('#set-recall', 5, 120, settings.recallSeconds),
    breakSeconds: readNumber('#set-break', 0, 300, settings.breakSeconds),
    noiseLevels: levels,
    noiseTypes: types,
  };
  const designChanged = ['sequenceLength', 'showSeconds', 'recallSeconds'].some(k => updated[k] !== settings[k]) ||
    updated.noiseLevels.join() !== settings.noiseLevels.join() || updated.noiseTypes.join() !== settings.noiseTypes.join();
  if (designChanged && groupMainTrials().length && !confirm('You already have test data. Changing the design now means participants are not tested the same way. Save anyway?')) return;
  settings = updated;
  saveSettings(settings);
  renderCalibration();
  fillSettingSpans();
}

function renderSequenceBank() {
  const conditions = getConditions(settings);
  const per = settings.trialsPerLevel;
  const bank = generateSequenceBank(conditions.length * per, settings.sequenceLength, settings.bankSeed);
  let html = '<div class="bank">';
  for (let s = 0; s < conditions.length; s++) {
    html += `<div class="bank-set"><b>Set ${orderGroupName(s)}</b><br>` +
      bank.slice(s * per, (s + 1) * per).map(item => `${item.id}  ${item.digits}`).join('<br>') + '</div>';
  }
  $('#sequence-bank').innerHTML = html + '</div>';
}

// ============================================================
// Results tab
// ============================================================

function sourceTrials() {
  const local = loadTrials();
  const hasDemo = local.some(t => t.demo);
  const base = resultsState.source === 'shared' ? knownTrials().filter(t => !t.demo) : local.filter(t => !t.demo);
  const hasReal = base.length > 0;
  const includeDemo = hasDemo && (resultsState.includeDemo ?? !hasReal);
  const all = includeDemo ? base.concat(local.filter(t => t.demo)) : base;
  return { all, includeDemo, hasDemo };
}

function filteredTrials(all) {
  return all.filter(t =>
    (resultsState.group === 'all' || (t.groupName || '') === resultsState.group) &&
    !resultsState.hidden.has(participantKey(t)));
}

function renderResults() {
  if (resultsState.source === 'shared' && Cloud.enabled && Date.now() - shared.loadedAt > 15000 && !shared.loading) {
    loadShared().then(() => { if (currentView() === 'results') renderResults(); });
  }
  renderSyncStatus();
  const { all, includeDemo, hasDemo } = sourceTrials();
  renderFilterBar(all, includeDemo, hasDemo);
  const trials = filteredTrials(all);
  const analysis = analyzeTrials(trials, settings);
  const pilot = analyzePilot(trials);
  const body = $('#results-body');
  let html = '';
  if (resultsState.source === 'shared' && shared.loading && !shared.loadedAt) {
    html += '<div class="notice">Loading everyone\'s results from the shared database…</div>';
  }
  if (resultsState.source === 'shared' && shared.error) {
    html += `<div class="notice warn">Couldn't reach the shared database (${escapeHtml(shared.error)}). Showing what this device has.</div>`;
  }
  if (includeDemo) {
    html += '<div class="demo-banner"><b>Demo data is shown.</b> These are made-up numbers to preview the graphs (they never upload). Remove them with "Remove demo data".</div>';
  }
  if (!analysis.trialCount && !pilot.count) {
    body.innerHTML = html + `<div class="card empty"><h2>No data yet</h2><p>Run a participant on the Run tab, or press <b>Load demo data</b> below to preview the graphs.</p></div>`;
    renderRawTable(trials);
    return;
  }
  if (analysis.trialCount) html += mainResultsHtml(analysis);
  if (pilot.count) html += pilotHtml(pilot);
  body.innerHTML = html;
  if (analysis.trialCount) drawCharts(analysis);
  renderRawTable(trials);
}

function renderFilterBar(all, includeDemo, hasDemo) {
  let html = '';
  if (Cloud.enabled) {
    html += `<div class="segmented" role="group" aria-label="Data source">
      <button class="${resultsState.source === 'shared' ? 'active' : ''}" data-source="shared">Everyone (shared)</button>
      <button class="${resultsState.source === 'device' ? 'active' : ''}" data-source="device">This device</button>
    </div>
    <button class="btn small" data-refresh title="Download the latest results">↻ Refresh</button>`;
  }
  const groups = [...new Set(all.map(t => t.groupName || ''))].sort();
  if (groups.length > 1 || (groups.length === 1 && groups[0])) {
    html += `<select id="group-filter" class="small-select" aria-label="Group">
      <option value="all">All groups</option>
      ${groups.map(g => `<option value="${escapeHtml(g)}" ${resultsState.group === g ? 'selected' : ''}>${escapeHtml(g || '(no group)')}</option>`).join('')}
    </select>`;
  }
  if (hasDemo) {
    html += `<label class="check"><input type="checkbox" id="include-demo" ${includeDemo ? 'checked' : ''}> Include demo data</label>`;
  }
  const participants = [...new Set(all
    .filter(t => t.phase === 'main' && (resultsState.group === 'all' || (t.groupName || '') === resultsState.group))
    .map(participantKey))].sort();
  if (participants.length) {
    html += '<div class="chips-row"><span class="label">Participants:</span>' + participants.map(code =>
      `<button class="btn small ${resultsState.hidden.has(code) ? '' : 'active'}" data-toggle-participant="${escapeHtml(code)}">${escapeHtml(code)}</button>`).join('') + '</div>';
  }
  $('#filter-bar').innerHTML = html;
  const select = $('#group-filter');
  if (select) select.value = resultsState.group;
}

function tile(label, value, sub) {
  return `<div class="tile"><div class="k">${label}</div><div class="v">${value}</div><div class="s">${sub || '&nbsp;'}</div></div>`;
}

function chartCard(id, title, subtitle, legend, readIt) {
  return `<div class="card chart-card">
    <div class="chart-head"><div><h2>${title}</h2><div class="chart-sub">${subtitle}</div></div>
      <button class="btn small" data-png="${id}" title="Download this chart as an image">⬇ PNG</button></div>
    ${legend || ''}
    <div class="chart" id="${id}"></div>
    ${readIt ? `<p class="read-it">${readIt}</p>` : ''}
  </div>`;
}

function legendHtml(items) {
  return '<div class="legend">' + items.map(item =>
    `<span><i class="${item.dashed ? 'dashed' : ''}" style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join('') + '</div>';
}

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const channel = shift => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return '#' + ((1 << 24) + (channel(16) << 16) + (channel(8) << 8) + channel(0)).toString(16).slice(1);
}

// Quiet is always gray; noise levels go from light to dark blue (louder = stronger colour).
function levelColor(key, keys) {
  const c = Charts.colors();
  if (key === 'quiet') return c.quiet;
  const noisy = keys.filter(k => k !== 'quiet');
  const t = noisy.length <= 1 ? 1 : noisy.indexOf(key) / (noisy.length - 1);
  return mixHex(c.rampStart, c.rampEnd, t);
}

// With many noise levels the serial position chart gets crowded, so show at most four:
// quiet, the quietest noise, a middle level and the loudest.
function serialLines(a) {
  const noisy = a.serialPosition.filter(s => s.key !== 'quiet');
  const quiet = a.serialPosition.filter(s => s.key === 'quiet');
  if (noisy.length <= 3) return a.serialPosition;
  const picks = [...new Set([0, Math.round((noisy.length - 1) / 2), noisy.length - 1])].map(i => noisy[i]);
  return quiet.concat(picks);
}

function mainResultsHtml(a) {
  const v = a.verdict;
  const reg = a.regression;
  const keys = a.conditions.map(c => c.key);
  let html = `<div class="card verdict ${v.tone}">
    <div class="tag">${v.tone === 'support' ? '✓' : v.tone === 'trend' ? '~' : '•'} Hypothesis check</div>
    <h2>${escapeHtml(v.title)}</h2><p>${escapeHtml(v.text)}</p>
    <p class="hint">H₀: recall accuracy does not differ across noise levels. H₁: recall accuracy decreases as noise level increases.</p>
  </div>`;

  html += '<div class="tiles">';
  html += tile('Trials', a.trialCount, `${a.participants.length} participant${a.participants.length === 1 ? '' : 's'}`);
  html += tile('Quiet', a.quiet ? fmt(a.quiet.stats.mean) + '%' : '–', 'mean correct');
  html += tile(a.loudest && a.loudest.key !== 'quiet' ? a.loudest.label : 'Loudest', a.loudest && a.loudest.key !== 'quiet' ? fmt(a.loudest.stats.mean) + '%' : '–', 'mean correct');
  html += tile('Quiet → loudest', Number.isFinite(a.drop) ? fmtSigned(a.drop) + ' pts' : '–', 'change in % correct');
  html += tile('Per +10 dB', reg ? fmtSigned(reg.slope * 10) + ' pts' : '–', 'slope of best-fit line');
  html += tile('Correlation r', reg ? fmtSigned(reg.r, 2) : '–', reg ? `R² = ${fmt(reg.r2, 2)} · p ${fmtP(reg.p).startsWith('<') ? '' : '= '}${fmtP(reg.p)}` : '');
  html += '</div>';

  const c = Charts.colors();
  html += chartCard('chart-levels', 'Recall accuracy at each noise level',
    'Mean % of digits recalled in the right position. Error bars: ±1 standard error. Dotted: line of best fit.',
    '', 'If the line slopes down, louder noise made recall worse.');
  html += '<div class="grid-2">';
  html += chartCard('chart-positions', 'Which positions were forgotten?',
    'Serial position curve: % correct at each place in the sequence' + (serialLines(a).length < a.serialPosition.length ? ' (a few levels shown so the lines stay readable).' : '.'),
    legendHtml(serialLines(a).map(s => ({ label: s.label, color: levelColor(s.key, keys) }))),
    'Usually the first and last digits are easiest (primacy and recency). Noise often hurts the middle most.');
  html += chartCard('chart-blocks', 'Order check: practice or tiredness?',
    'Mean % correct by which part of the session it was (1st, 2nd…), all levels mixed.',
    '', 'Because the order of noise levels was counterbalanced, a practice or tiredness effect does not favour any one level.');
  html += '</div>';
  if (a.types.length > 1) {
    html += chartCard('chart-types', 'By type of noise',
      'Same measure, split by noise type. Dashed line: the quiet control.',
      legendHtml(a.types.map(type => ({ label: NOISE_INFO[type].label, color: c[type] }))
        .concat([{ label: 'Quiet baseline', color: c.quiet, dashed: true }])),
      'Research predicts talking (changing sound with meaning) hurts most and steady white noise least.');
  }

  html += statsCardHtml(a);
  html += tablesHtml(a);
  return html;
}

function statsCardHtml(a) {
  const reg = a.regression;
  const line = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
  let html = '<div class="grid-2"><div class="card"><h2>Statistical tests</h2><div class="stats-list">';
  if (reg) {
    html += line('Best-fit line', `score = ${fmt(reg.intercept)} ${reg.slope < 0 ? '−' : '+'} ${fmt(Math.abs(reg.slope), 3)} × dB`);
    html += line('Correlation r / R²', `${fmt(reg.r, 3)} / ${fmt(reg.r2, 3)}`);
    html += line(`Slope t-test (df = ${reg.df})`, `t = ${fmt(reg.t, 2)}, p ${fmtP(reg.p)}`);
  }
  html += line('Repeated-measures ANOVA (levels)', a.rmAnova ? `F(${a.rmAnova.df1}, ${a.rmAnova.df2}) = ${fmt(a.rmAnova.F, 2)}, p ${fmtP(a.rmAnova.p)}` : 'needs ≥ 2 people with every level');
  html += line('One-way ANOVA (levels, all trials)', a.anova ? `F(${a.anova.df1}, ${a.anova.df2}) = ${fmt(a.anova.F, 2)}, p ${fmtP(a.anova.p)}` : '–');
  if (a.typeAnova) html += line('One-way ANOVA (noise types)', `F(${a.typeAnova.df1}, ${a.typeAnova.df2}) = ${fmt(a.typeAnova.F, 2)}, p ${fmtP(a.typeAnova.p)}`);
  html += '</div></div>';
  html += `<div class="card"><h2>What these mean</h2>
    <p><b>p-value:</b> the chance of seeing a difference this big if noise really had no effect. Below 0.05 counts as "statistically significant".</p>
    <p><b>Slope:</b> how many percentage points the score changes for each extra dB. Negative = louder is worse.</p>
    <p><b>r:</b> correlation from −1 to 1. Close to −1 means a strong "louder → worse" pattern. R² is the share of the variation explained by noise level.</p>
    <p><b>Repeated-measures ANOVA:</b> the best test for our design, because every person did every level. It removes the fact that some people just have better memory.</p>
    <p class="hint">With only a few participants the tests have low power: a real effect might not reach p &lt; 0.05. Say this in your limitations.</p>
  </div></div>`;
  return html;
}

function heatStyle(percent) {
  if (!Number.isFinite(percent)) return '';
  const step = percent < 40 ? 0 : percent < 60 ? 1 : percent < 80 ? 2 : 3;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = step >= 2 || dark ? '#ffffff' : '#0b0b0b';
  return `background:var(--heat-${step});color:${ink}`;
}

function tablesHtml(a) {
  const statsCells = s => `<td class="num">${s.n}</td><td class="num">${fmt(s.mean)}%</td><td class="num">${fmt(s.sd)}</td><td class="num">${fmt(s.se)}</td><td class="num">${fmt(s.min, 0)}–${fmt(s.max, 0)}%</td>`;
  let html = '<div class="card"><h2>Summary by noise level</h2><div class="table-wrap"><table><thead><tr><th>Condition</th><th class="num">dB(A)</th><th class="num">Trials</th><th class="num">Mean</th><th class="num">SD</th><th class="num">SE</th><th class="num">Range</th></tr></thead><tbody>';
  html += a.conditions.map(c => `<tr><td>${escapeHtml(c.label)}</td><td class="num">${fmt(c.x, 0)}</td>${statsCells(c.stats)}</tr>`).join('');
  html += '</tbody></table></div>';

  const noisy = a.conditions.filter(c => c.key !== 'quiet');
  if (noisy.length && a.types.length > 1) {
    html += '<h3>Mean % correct by noise type and level</h3><div class="table-wrap"><table><thead><tr><th>Noise type</th>';
    html += noisy.map(c => `<th class="num">${escapeHtml(c.label)}</th>`).join('') + '<th class="num">All levels</th></tr></thead><tbody>';
    for (const type of a.types) {
      html += `<tr><td><span class="swatch" style="background:var(--series-${type})"></span> ${NOISE_INFO[type].label}</td>`;
      html += a.byType[type].map(cell => `<td class="num">${fmt(cell.stats.mean)}% <span class="hint">n=${cell.stats.n}</span></td>`).join('');
      html += `<td class="num"><b>${fmt(a.typeOverall[type].mean)}%</b></td></tr>`;
    }
    html += '</tbody></table></div>';
  }

  html += '<h3>Each participant (mean % correct)</h3><div class="table-wrap"><table><thead><tr><th>Participant</th>';
  html += a.conditions.map(c => `<th class="num">${escapeHtml(c.label)}</th>`).join('') + '<th class="num">Overall</th></tr></thead><tbody>';
  for (const row of a.participantTable) {
    html += `<tr><td>${escapeHtml(row.participant)}</td>`;
    html += a.conditions.map(c => `<td class="heat" style="${heatStyle(row.cells[c.key].mean)}">${row.cells[c.key].n ? fmt(row.cells[c.key].mean, 0) + '%' : '–'}</td>`).join('');
    html += `<td class="num"><b>${fmt(row.overall.mean)}%</b></td></tr>`;
  }
  html += '</tbody></table></div><p class="hint">Darker = better recall. Colours: under 40%, 40–60%, 60–80%, 80%+.</p></div>';
  return html;
}

function pilotHtml(pilot) {
  const rows = pilot.rows.map(r => `<tr${pilot.suggestion && r.length === pilot.suggestion.length ? ' style="font-weight:600"' : ''}><td>${r.length} digits</td><td class="num">${r.stats.n}</td><td class="num">${fmt(r.stats.mean)}%</td></tr>`).join('');
  return `<div class="card"><h2>Pilot test — choosing the sequence length</h2>
    <div class="table-wrap"><table><thead><tr><th>Length</th><th class="num">Trials</th><th class="num">Mean correct</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p>Suggested length: <b>${pilot.suggestion ? pilot.suggestion.length + ' digits' : '–'}</b> — closest to 75% correct in quiet, so there is room for noise to lower the score without everyone scoring zero. Currently set to ${settings.sequenceLength}.</p>
    <p class="hint">Pilot trials are never mixed into the main results.</p></div>`;
}

function drawCharts(a) {
  const c = Charts.colors();
  const keys = a.conditions.map(cond => cond.key);
  const xs = a.conditions.map(cond => cond.x);
  const xDomain = [Math.min(...xs) - 6, Math.max(...xs) + 6];
  const xTicks = a.conditions.map(cond => ({ value: cond.x, label: cond.key === 'quiet' ? `Quiet\n(${fmt(cond.x, 0)} dB)` : cond.label }));
  const reg = a.regression;

  Charts.line($('#chart-levels'), {
    title: 'Recall accuracy at each noise level',
    ariaLabel: 'Line chart of mean recall accuracy by noise level',
    series: [{ name: 'Mean', color: c.accent, points: a.conditions.map(cond => ({ x: cond.x, y: cond.stats.mean, se: cond.stats.se, n: cond.stats.n })) }],
    xDomain, xTicks, yDomain: [0, 100],
    yLabel: '% correct', xLabel: 'Background noise level, dB(A)',
    trend: reg ? { slope: reg.slope, intercept: reg.intercept, from: Math.min(...xs), to: Math.max(...xs) } : null,
  });

  const length = a.serialPosition.length ? a.serialPosition[0].values.length : 0;
  Charts.line($('#chart-positions'), {
    title: 'Serial position curve',
    ariaLabel: 'Line chart of accuracy by position in the sequence',
    series: serialLines(a).map(s => ({
      name: s.label,
      color: levelColor(s.key, keys),
      points: s.values.map((value, position) => ({ x: position + 1, y: value })),
    })),
    xDomain: [0.6, length + 0.4],
    xTicks: Array.from({ length }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    yDomain: [0, 100], yLabel: '% correct', xLabel: 'Position in the sequence',
  });

  Charts.bar($('#chart-blocks'), {
    title: 'Order check: % correct by part of the session',
    ariaLabel: 'Bar chart of accuracy by session part',
    color: c.accent,
    bars: a.byBlock.map(b => ({ label: String(b.block), value: b.stats.mean, se: b.stats.se, n: b.stats.n })),
    yDomain: [0, 100], yLabel: '% correct',
  });

  if (a.types.length > 1) {
    Charts.line($('#chart-types'), {
      title: 'Recall accuracy by type of noise',
      ariaLabel: 'Line chart of recall accuracy by noise type and level',
      series: a.types.map(type => ({
        name: NOISE_INFO[type].short,
        color: c[type],
        points: a.byType[type].map(cell => ({ x: cell.x, y: cell.stats.mean, se: cell.stats.se, n: cell.stats.n })),
      })),
      reference: a.quiet ? { y: a.quiet.stats.mean, label: `Quiet ${fmt(a.quiet.stats.mean, 0)}%` } : null,
      xDomain, xTicks, yDomain: [0, 100],
      yLabel: '% correct', xLabel: 'Background noise level, dB(A)',
    });
  }
}

function renderRawTable(trials) {
  if (!trials.length) {
    $('#raw-table').innerHTML = '<p class="hint">No trials to show.</p>';
    return;
  }
  const rows = trials.slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 500).map(t => {
    const response = [...(t.response || '')].map((ch, i) => ch === t.sequence[i] ? escapeHtml(ch) : `<span class="miss">${escapeHtml(ch)}</span>`).join('');
    const where = t.demo ? '<span class="hint">demo</span>' : t.synced ? '☁' : '<span class="hint" title="Not uploaded yet">⏳</span>';
    return `<tr><td>${escapeHtml(t.groupName || '–')}</td><td>${escapeHtml(t.participant)}</td><td>${escapeHtml(t.phase)}</td><td class="num">${t.block ?? ''}</td>
      <td>${escapeHtml(conditionLabel(t.condition))}</td><td>${escapeHtml(NOISE_INFO[t.noiseType]?.short || t.noiseType)}</td>
      <td class="mono">${escapeHtml(t.sequence)}</td><td class="mono">${response}</td><td class="num">${t.correct}/${t.length}</td>
      <td class="num">${fmt(Number(t.percent), 0)}%</td><td class="num">${fmt((t.responseMs || 0) / 1000)} s</td><td>${where}</td>
      <td><button class="icon-btn" data-delete-trial="${escapeHtml(t.trialId)}" title="Delete this trial" aria-label="Delete trial">×</button></td></tr>`;
  }).join('');
  $('#raw-table').innerHTML = `<table><thead><tr><th>Group</th><th>Participant</th><th>Phase</th><th class="num">Part</th><th>Level</th><th>Noise</th><th>Shown</th><th>Typed</th><th class="num">Correct</th><th class="num">%</th><th class="num">Time</th><th>Saved</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
    (trials.length > 500 ? '<p class="hint">Showing the newest 500. Export CSV for everything.</p>' : '');
}

async function onDeleteTrial(trialId) {
  const trial = knownTrials().find(t => t.trialId === trialId) || loadTrials().find(t => t.trialId === trialId);
  if (!trial) return;
  if (trial.synced && Cloud.enabled) {
    const passcode = prompt('This trial is in the shared database. Enter the admin passcode to delete it for everyone:');
    if (!passcode) return;
    try {
      await Cloud.deleteTrials([trialId], passcode);
    } catch (error) {
      return alert('Not deleted: ' + error.message);
    }
    shared.trials = shared.trials.filter(t => t.trialId !== trialId);
  } else if (!confirm('Delete this trial? (For example, if the participant was interrupted.)')) {
    return;
  }
  deleteTrial(trialId);
  renderResults();
}

// ---------- Data buttons ----------

function exportTrialsCsv() {
  const trials = filteredTrials(sourceTrials().all);
  if (!trials.length) return alert('No data to export yet.');
  const name = resultsState.source === 'shared' ? 'everyone' : 'this-device';
  downloadFile(`noise-recall-trials-${name}-${today()}.csv`, '﻿' + toCSV(trials, TRIAL_COLUMNS), 'text/csv;charset=utf-8');
}

function exportSummaryCsv() {
  const a = analyzeTrials(filteredTrials(sourceTrials().all), settings);
  if (!a.trialCount) return alert('No main-test data to summarise yet.');
  const rows = [];
  const add = (group, condition, noiseType, s) => rows.push({ group, condition, noiseType, n: s.n, mean: fmt(s.mean, 2), sd: fmt(s.sd, 2), se: fmt(s.se, 2), min: fmt(s.min, 1), max: fmt(s.max, 1) });
  a.conditions.forEach(c => add('by level', c.label, 'all', c.stats));
  if (a.types.length > 1) {
    a.types.forEach(type => a.byType[type].forEach(cell => add('by type and level', cell.label, NOISE_INFO[type].label, cell.stats)));
    a.types.forEach(type => add('by type', 'all noisy levels', NOISE_INFO[type].label, a.typeOverall[type]));
  }
  a.participantTable.forEach(row => a.conditions.forEach(c => add('participant ' + row.participant, c.label, 'all', row.cells[c.key])));
  let csv = toCSV(rows, ['group', 'condition', 'noiseType', 'n', 'mean', 'sd', 'se', 'min', 'max']);
  if (a.regression) csv += `\n\nregression slope per dB,${fmt(a.regression.slope, 4)}\nintercept,${fmt(a.regression.intercept, 2)}\nr,${fmt(a.regression.r, 4)}\nR squared,${fmt(a.regression.r2, 4)}\np (slope),${fmtP(a.regression.p)}`;
  if (a.rmAnova) csv += `\nrepeated-measures ANOVA F(${a.rmAnova.df1}/${a.rmAnova.df2}),${fmt(a.rmAnova.F, 3)}\np (RM ANOVA),${fmtP(a.rmAnova.p)}`;
  downloadFile(`noise-recall-summary-${today()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const imported = trialsFromCSV(String(reader.result)).filter(t => !t.demo).map(t => ({ ...t, synced: false }));
    if (!imported.length) return alert('No trials found in that file. Use a CSV exported from this site.');
    const added = mergeTrials(imported);
    alert(`Imported ${added} new trial${added === 1 ? '' : 's'} (${imported.length - added} already on this device).` +
      (Cloud.enabled ? ' They will be uploaded to the shared database.' : ''));
    await syncPending();
    await loadShared(true);
    renderResults();
  };
  reader.readAsText(file);
}

// Made-up data that follows the expected pattern, to preview graphs before testing. Never uploaded.
function loadDemoData() {
  if (loadTrials().some(t => t.demo)) return alert('Demo data is already loaded.');
  const penalty = { none: 0, white: 0.03, construction: 0.07, talking: 0.09 };
  const demo = [];
  const conditions = getConditions(settings).length;
  for (let p = 0; p < Math.max(4, Math.min(conditions, 6)); p++) {
    const random = createRandom(900 + p);
    const plan = buildSessionPlan('DEMO-' + (p + 1), p % conditions, settings);
    const session = { id: 'demo' + p, participant: 'DEMO-' + (p + 1), groupName: 'Demo group' };
    const ability = 0.95 - p * 0.04;
    let trialNumber = 0;
    plan.blocks.forEach((block, b) => block.trials.forEach((trial, i) => {
      trialNumber++;
      const db = block.condition.db ?? settings.quietRoomDb;
      const L = trial.digits.length;
      let response = '';
      for (let k = 0; k < L; k++) {
        const middle = 1 - Math.abs((k / (L - 1)) * 2 - 1);
        const chance = ability - 0.0045 * (db - settings.quietRoomDb) - penalty[trial.noiseType] - 0.25 * middle * middle + 0.01 * b;
        response += random() < chance ? trial.digits[k] : random() < 0.4 ? '_' : String(1 + Math.floor(random() * 9));
      }
      demo.push(makeTrialRecord({
        session, plan, block, blockIndex: b, trialIndex: i, trialNumber, trial, response,
        responseMs: Math.round(8000 + random() * 18000), gainDb: null, demo: true,
      }));
    }));
  }
  saveTrials(loadTrials().concat(demo));
  resultsState.includeDemo = null;
  renderResults();
}

function clearDemoData() {
  saveTrials(loadTrials().filter(t => !t.demo));
  resultsState.includeDemo = null;
  renderResults();
}

function deleteDeviceData() {
  const pending = loadTrials().filter(t => !t.demo && !t.synced).length;
  const warning = pending ? `\n\n${pending} trial(s) have NOT been uploaded yet and would be lost!` : '\n\nTrials already in the shared database are not affected.';
  const answer = prompt(`This deletes every trial and session saved on THIS device. Export a CSV first!${warning}\n\nType DELETE to confirm.`);
  if (answer !== 'DELETE') return;
  saveTrials([]);
  saveJSON(STORAGE_KEYS.sessions, []);
  resultsState.hidden.clear();
  renderResults();
}

// ============================================================
// Wiring it all up
// ============================================================

function setup() {
  $$('.tab').forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view)));
  window.addEventListener('hashchange', () => { if (!runner) showView(location.hash.slice(1)); });

  // Run tab
  $('#start-session').addEventListener('click', () => onStartSession(false));
  $('#start-pilot').addEventListener('click', () => onStartSession(true));
  $('#participant-code').addEventListener('input', updateOrderPreview);
  $('#order-group').addEventListener('change', updateOrderPreview);
  $('#group-name').addEventListener('change', event => {
    settings.groupName = normalizeGroup(event.target.value);
    saveSettings(settings);
    refreshAutoOrder();
  });
  $$('[data-ear]').forEach(button => button.addEventListener('click', async () => {
    await ensureAudio(button);
    NoiseEngine.testEar(button.dataset.ear);
  }));
  document.addEventListener('click', event => {
    if (event.target.closest('[data-sync-now]')) syncPending().then(() => { if (currentView() === 'results') renderResults(); });
  });

  // Stage
  $('#stage-stop').addEventListener('click', requestStop);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && runner) requestStop(); });
  window.addEventListener('beforeunload', event => { if (runner) event.preventDefault(); });

  // Calibrate tab
  $('#calibration-rows').addEventListener('click', onCalibrationClick);
  $('#calibration-rows').addEventListener('change', onCalibrationInput);
  $('#stop-all').addEventListener('click', () => { if (NoiseEngine.ready) NoiseEngine.stop(0.2); });
  $('#volume-note').addEventListener('change', event => { settings.volumeNote = event.target.value.trim(); saveSettings(settings); });
  $('#quiet-db').addEventListener('change', event => {
    const value = parseFloat(event.target.value);
    if (Number.isFinite(value)) { settings.quietRoomDb = value; saveSettings(settings); }
  });
  $('#save-settings').addEventListener('click', onSaveSettings);
  $('#reset-settings').addEventListener('click', () => {
    if (!confirm('Reset experiment settings to the defaults? Calibration is kept.')) return;
    settings = { ...DEFAULT_SETTINGS, calibration: settings.calibration, verification: settings.verification, volumeNote: settings.volumeNote, quietRoomDb: settings.quietRoomDb, groupName: settings.groupName };
    saveSettings(settings);
    renderCalibration();
  });

  // Results tab
  $('#export-csv').addEventListener('click', exportTrialsCsv);
  $('#export-summary').addEventListener('click', exportSummaryCsv);
  $('#import-csv').addEventListener('change', event => { if (event.target.files[0]) importCsv(event.target.files[0]); event.target.value = ''; });
  $('#load-demo').addEventListener('click', loadDemoData);
  $('#clear-demo').addEventListener('click', clearDemoData);
  $('#delete-all').addEventListener('click', deleteDeviceData);
  $('#filter-bar').addEventListener('click', event => {
    const source = event.target.closest('[data-source]');
    if (source) { resultsState.source = source.dataset.source; resultsState.hidden.clear(); return renderResults(); }
    if (event.target.closest('[data-refresh]')) {
      shared.loadedAt = 0;
      return loadShared(true).then(renderResults);
    }
    const button = event.target.closest('[data-toggle-participant]');
    if (!button) return;
    const code = button.dataset.toggleParticipant;
    resultsState.hidden.has(code) ? resultsState.hidden.delete(code) : resultsState.hidden.add(code);
    renderResults();
  });
  $('#filter-bar').addEventListener('change', event => {
    if (event.target.id === 'include-demo') { resultsState.includeDemo = event.target.checked; renderResults(); }
    if (event.target.id === 'group-filter') { resultsState.group = event.target.value; resultsState.hidden.clear(); renderResults(); }
  });
  $('#results-body').addEventListener('click', event => {
    const button = event.target.closest('[data-png]');
    if (button) Charts.downloadPng($('#' + button.dataset.png), button.dataset.png + '.png');
  });
  $('#raw-table').addEventListener('click', event => {
    const button = event.target.closest('[data-delete-trial]');
    if (button) onDeleteTrial(button.dataset.deleteTrial);
  });

  // Keep uploading anything that didn't make it (e.g. school Wi-Fi dropped).
  window.addEventListener('online', syncPending);
  setInterval(() => { if (!runner && loadTrials().some(t => !t.demo && !t.synced)) syncPending(); }, 30000);

  // Redraw charts when the window size or light/dark mode changes.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (currentView() === 'results') renderResults(); }, 200);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentView() === 'results') renderResults(); });

  showView(location.hash.slice(1) || 'run');
  syncPending();
}

setup();
