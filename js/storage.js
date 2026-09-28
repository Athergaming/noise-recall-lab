// ===== Noise & Recall Lab — saving and loading data =====
// Everything is stored in this browser's localStorage, so data survives refreshing or
// closing the page. Use "Export CSV" on the Results tab to back it up or move it to
// another computer.

const STORAGE_KEYS = {
  settings: 'noiseRecall.settings',
  trials: 'noiseRecall.trials',
  sessions: 'noiseRecall.sessions',
};

const SETTINGS_VERSION = 3; // bump when the default experiment design changes

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  groupName: '',         // e.g. "Riya's group" — keeps different groups' P1, P2… apart
  sequenceLength: 15,    // digits per sequence
  showSeconds: 15,       // how long the sequence stays on screen
  recallSeconds: 30,     // time to type the answer
  trialsPerLevel: 6,     // sequences per noise level
  breakSeconds: 20,      // rest between noise levels
  leadInSeconds: 2,      // noise starts this long before the digits appear
  noiseLevels: [40, 50, 60, 70, 80, 90], // dB(A) levels besides the quiet control
  noiseTypes: ['talking'], // which background sounds to use (talking, white, construction)
  quietRoomDb: 30,       // measured level of the quiet condition, used on graphs
  bankSeed: 2026,        // same seed = same sequence bank for every participant
  volumeNote: '',        // e.g. "MacBook volume 8/16 bars"
  calibration: { talking: null, white: null, construction: null },
  verification: {},      // physics check readings: { "talking-55": 54.2, ... }
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    alert('Could not save to this browser. Export your data as CSV right away so nothing is lost.');
    return false;
  }
}

// Experiment design fields are reset to the new defaults when SETTINGS_VERSION changes,
// so every device runs the same design. Calibration and device notes are kept.
const DESIGN_FIELDS = ['sequenceLength', 'showSeconds', 'recallSeconds', 'trialsPerLevel', 'breakSeconds', 'leadInSeconds', 'noiseLevels', 'noiseTypes', 'bankSeed'];

function loadSettings() {
  const saved = loadJSON(STORAGE_KEYS.settings, {});
  if (saved.settingsVersion !== SETTINGS_VERSION) {
    for (const field of DESIGN_FIELDS) delete saved[field];
    saved.settingsVersion = SETTINGS_VERSION;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    calibration: { ...DEFAULT_SETTINGS.calibration, ...(saved.calibration || {}) },
    verification: { ...(saved.verification || {}) },
  };
}

function saveSettings(settings) {
  return saveJSON(STORAGE_KEYS.settings, settings);
}

function loadTrials() {
  return loadJSON(STORAGE_KEYS.trials, []);
}

function saveTrials(trials) {
  return saveJSON(STORAGE_KEYS.trials, trials);
}

function addTrial(trial) {
  const trials = loadTrials();
  trials.push(trial);
  saveTrials(trials);
}

function deleteTrial(trialId) {
  saveTrials(loadTrials().filter(t => t.trialId !== trialId));
}

// Marks trials as uploaded to the shared database.
function markSynced(trialIds) {
  const ids = new Set(trialIds);
  saveTrials(loadTrials().map(t => (ids.has(t.trialId) ? { ...t, synced: true } : t)));
}

function loadSessions() {
  return loadJSON(STORAGE_KEYS.sessions, []);
}

function saveSession(session) {
  const sessions = loadSessions().filter(s => s.id !== session.id);
  sessions.push(session);
  saveJSON(STORAGE_KEYS.sessions, sessions);
}

// ---------- CSV export / import ----------

const TRIAL_COLUMNS = [
  'trialId', 'sessionId', 'groupName', 'participant', 'phase', 'orderGroup', 'block', 'trialInBlock',
  'trialNumber', 'condition', 'noiseType', 'intendedDb', 'gainDb', 'calibrated',
  'sequenceId', 'sequence', 'response', 'correct', 'length', 'percent',
  'positionsCorrect', 'responseMs', 'showSeconds', 'recallSeconds', 'deviceNote', 'timestamp', 'demo',
];

const NUMBER_COLUMNS = ['block', 'trialInBlock', 'trialNumber', 'intendedDb', 'gainDb', 'correct', 'length', 'percent', 'responseMs', 'showSeconds', 'recallSeconds'];
const BOOLEAN_COLUMNS = ['calibrated', 'demo'];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCSV(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(column => csvEscape(row[column])).join(','));
  }
  return lines.join('\n');
}

// Splits CSV text into rows of cells, handling quoted cells that contain commas.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') inQuotes = false;
      else cell += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell); cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function trialsFromCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(cells => {
    const trial = {};
    header.forEach((column, index) => {
      const raw = (cells[index] ?? '').trim();
      if (NUMBER_COLUMNS.includes(column)) trial[column] = raw === '' ? null : Number(raw);
      else if (BOOLEAN_COLUMNS.includes(column)) trial[column] = raw.toLowerCase() === 'true';
      else trial[column] = raw;
    });
    return trial;
  }).filter(t => t.trialId && t.sequence);
}

// Adds imported trials, skipping any trial that is already saved (same trialId).
function mergeTrials(newTrials) {
  const trials = loadTrials();
  const known = new Set(trials.map(t => t.trialId));
  let added = 0;
  for (const trial of newTrials) {
    if (!known.has(trial.trialId)) {
      trials.push(trial);
      known.add(trial.trialId);
      added++;
    }
  }
  saveTrials(trials);
  return added;
}

function downloadFile(filename, content, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
