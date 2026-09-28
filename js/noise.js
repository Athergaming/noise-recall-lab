// ===== Noise & Recall Lab — background noise engine (Web Audio API) =====
// Three noise types are prepared once, then looped during each trial:
//   talking      – a real recording of a group of people talking (changing-state speech)
//   white        – steady hiss with equal energy at all frequencies (steady-state)
//   construction – a real recording of a construction site with drilling (changing-state, non-speech)
// Every sound is scaled to the same digital loudness (RMS), then the calibration from the
// physics student converts "I want 55 dB(A)" into the exact volume to play.

const NOISE_INFO = {
  none: { label: 'None (quiet)', short: 'Quiet' },
  talking: { label: 'Talking', short: 'Talking', description: 'Real recording: a group of people talking in the next room.' },
  white: { label: 'White noise', short: 'White', description: 'A steady "shhh" hiss, like TV static or a loud fan.' },
  construction: { label: 'Construction', short: 'Construction', description: 'Real recording: a construction site with loud drilling.' },
};

const TARGET_RMS_DBFS = -30;          // every noise is normalised to this digital level
const UNCALIBRATED_REFERENCE_DB = 78; // rough guess of dB(A) at 0 dB gain, until calibrated
const MAX_SAFE_DB = 90; // short exposures only: NIOSH allows ~2.5 h per day at 90 dB(A)

function dbToGain(db) { return Math.pow(10, db / 20); }
function gainToDb(gain) { return 20 * Math.log10(gain); }

// ----- Building the sounds (pure maths on arrays of samples) -----

function gaussianNoise(random) {
  // Box–Muller: turns two uniform random numbers into a bell-curve (natural) random value.
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rms(samples) {
  let total = 0;
  for (let i = 0; i < samples.length; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
  return max;
}

function normalize(samples, targetDbfs) {
  const factor = dbToGain(targetDbfs) / rms(samples);
  for (let i = 0; i < samples.length; i++) samples[i] *= factor;
  return samples;
}

function makeWhiteNoise(sampleRate, seconds) {
  const random = createRandom(11);
  const samples = new Float32Array(Math.floor(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = gaussianNoise(random);
  return samples;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ----- The engine -----

const NoiseEngine = {
  context: null,
  buffers: {},
  peakDb: {},
  playing: null,
  ready: false,
  loading: null,

  // Must be called from a click (browsers only allow sound after the user interacts).
  init() {
    if (this.ready) return this.context.resume();
    if (this.loading) return this.loading;
    this.loading = this._load();
    return this.loading;
  },

  async _load() {
    // iPhone/iPad: play even when the silent switch is on.
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch (error) { /* older iOS */ }
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();
    await this.context.resume();
    const sampleRate = this.context.sampleRate;

    const talking = await this._decode(base64ToArrayBuffer(TALKING_AUDIO_BASE64));
    this._store('talking', talking.getChannelData(0).slice(), talking.sampleRate);
    const construction = await this._decode(base64ToArrayBuffer(CONSTRUCTION_AUDIO_BASE64));
    this._store('construction', construction.getChannelData(0).slice(), construction.sampleRate);
    this._store('white', makeWhiteNoise(sampleRate, 10), sampleRate);
    this.ready = true;
  },

  _decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      this.context.decodeAudioData(arrayBuffer, resolve, reject);
    });
  },

  _store(type, samples, sampleRate) {
    normalize(samples, TARGET_RMS_DBFS);
    this.peakDb[type] = gainToDb(peak(samples));
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    this.buffers[type] = buffer;
  },

  // Turns a target level in dB(A) into a digital gain using the saved calibration.
  // Calibration = "at gain G the meter read M dB(A)", so target T needs gain G + (T − M).
  gainFor(type, targetDb, calibration) {
    const cal = calibration && calibration[type];
    const gainDb = cal ? cal.atGainDb + (targetDb - cal.measuredDb) : targetDb - UNCALIBRATED_REFERENCE_DB;
    const headroom = this.peakDb[type] !== undefined ? -this.peakDb[type] : 12;
    return { gainDb, calibrated: Boolean(cal), clipping: gainDb > headroom, headroom };
  },

  play(type, targetDb, calibration, fadeSeconds = 0.5) {
    this.stop(0.05);
    const ctx = this.context;
    const { gainDb, calibrated, clipping } = this.gainFor(type, Math.min(targetDb, MAX_SAFE_DB), calibration);
    const source = ctx.createBufferSource();
    source.buffer = this.buffers[type];
    source.loop = true;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(dbToGain(gainDb), now + fadeSeconds);
    source.connect(gain).connect(ctx.destination);
    // Start somewhere random so each trial hears a different part of the sound.
    source.start(now, Math.random() * source.buffer.duration);
    this.playing = { source, gain, type, targetDb, gainDb };
    return { gainDb, calibrated, clipping };
  },

  stop(fadeSeconds = 0.5) {
    if (!this.playing) return;
    const { source, gain } = this.playing;
    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
    source.stop(now + fadeSeconds + 0.05);
    this.playing = null;
  },

  // Short beep in one ear, to check both AirPods are in and working.
  testEar(side) {
    const ctx = this.context;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.frequency.value = side === 'left' ? 520 : 780;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
    gain.gain.setValueAtTime(0.08, now + 0.7);
    gain.gain.linearRampToValueAtTime(0, now + 0.8);
    let node = osc.connect(gain);
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = side === 'left' ? -1 : 1;
      node = node.connect(panner);
    }
    node.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.85);
  },
};
