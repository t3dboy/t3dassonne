// ============================================================================
// T3dassonne — Audio system. Fully synthesized (WebAudio API), no assets.
// Cozy, warm "Stardew Valley" farm vibe. Implements AudioApi (see core/types).
// ============================================================================

import type { AudioApi, SfxName } from "../core/types";

// ---- Constants -------------------------------------------------------------

const MUTE_KEY = "t3d_muted";
const MASTER_VOL = 0.9; // headroom under 1.0 to avoid clipping
const MUSIC_VOL = 0.12; // gentle background level
const RAMP = 0.008; // short ramp (s) used everywhere to avoid clicks/pops

// Safari/iOS exposes the ctor as webkitAudioContext.
type AudioCtxCtor = typeof AudioContext;
interface WebkitWindow {
  webkitAudioContext?: AudioCtxCtor;
}

// ---- Module state ----------------------------------------------------------

let ctx: AudioContext | null = null;
let master: GainNode | null = null; // everything routes through here
let sfxBus: GainNode | null = null; // sfx sub-mix
let musicBus: GainNode | null = null; // music sub-mix

let muted = false;
let musicPlaying = false;

// A small shared white-noise buffer, created once on init.
let noiseBuffer: AudioBuffer | null = null;

// ---- Music scheduler state -------------------------------------------------

let schedulerTimer: number | null = null;
let nextNoteTime = 0; // absolute AudioContext time of the next step
let step = 0; // running step counter (drives generative pattern)
const LOOKAHEAD_MS = 25; // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.1; // how far ahead we queue audio (s)
const BPM = 68; // slow, cozy tempo
const STEP_DUR = 60 / BPM / 2; // an eighth-note per step

// Warm major/pentatonic palette (Hz). C major pentatonic across two octaves.
const LEAD_SCALE = [
  261.63, 293.66, 329.63, 392.0, 440.0, // C4 D4 E4 G4 A4
  523.25, 587.33, 659.25, 783.99, 880.0, // C5 D5 E5 G5 A5
];
// Simple I–vi–IV–V-ish warm bass roots (C, A, F, G) in a low octave.
const BASS_ROOTS = [130.81, 110.0, 174.61, 196.0]; // C3 A2 F3 G3

// ============================================================================
// Helpers
// ============================================================================

function now(): number {
  return ctx ? ctx.currentTime : 0;
}

/** Ramp a param to a target smoothly from its current value (no clicks). */
function ramp(param: AudioParam, value: number, at: number, dur = RAMP): void {
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(value, at + dur);
}

/** Create a decaying tone (oscillator -> gain) and auto-clean-up. */
function tone(
  dest: AudioNode,
  opts: {
    type?: OscillatorType;
    freq: number;
    start: number; // absolute time
    dur: number;
    peak: number; // gain peak
    attack?: number;
    glideTo?: number; // optional pitch glide target
    detune?: number;
  },
): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, opts.start);
  if (opts.detune) osc.detune.setValueAtTime(opts.detune, opts.start);
  if (opts.glideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, opts.glideTo),
      opts.start + opts.dur,
    );
  }
  const atk = opts.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, opts.start);
  g.gain.exponentialRampToValueAtTime(opts.peak, opts.start + atk);
  // Smooth exponential-ish decay to near-zero.
  g.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur);
  osc.connect(g).connect(dest);
  osc.start(opts.start);
  osc.stop(opts.start + opts.dur + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      g.disconnect();
    } catch {
      /* already gone */
    }
  };
}

/** Fire a short filtered noise burst (wood/click/paper textures). */
function noise(
  dest: AudioNode,
  opts: {
    start: number;
    dur: number;
    peak: number;
    type?: BiquadFilterType;
    freq: number;
    q?: number;
    attack?: number;
  },
): void {
  if (!ctx || !noiseBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = opts.type ?? "bandpass";
  filter.frequency.setValueAtTime(opts.freq, opts.start);
  filter.Q.setValueAtTime(opts.q ?? 1, opts.start);
  const g = ctx.createGain();
  const atk = opts.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, opts.start);
  g.gain.exponentialRampToValueAtTime(opts.peak, opts.start + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur);
  src.connect(filter).connect(g).connect(dest);
  src.start(opts.start);
  src.stop(opts.start + opts.dur + 0.02);
  src.onended = () => {
    try {
      src.disconnect();
      filter.disconnect();
      g.disconnect();
    } catch {
      /* already gone */
    }
  };
}

// ============================================================================
// SFX voices — each is short (<0.5s), pleasant, and distinct.
// ============================================================================

function sfxPlace(t: number, d: AudioNode): void {
  // Soft wooden "tock": tight noise click + low sine thud.
  noise(d, { start: t, dur: 0.05, peak: 0.25, type: "bandpass", freq: 1400, q: 1.2 });
  tone(d, { type: "sine", freq: 180, glideTo: 90, start: t, dur: 0.14, peak: 0.5, attack: 0.004 });
  tone(d, { type: "triangle", freq: 300, glideTo: 200, start: t, dur: 0.08, peak: 0.15 });
}

function sfxRotate(t: number, d: AudioNode): void {
  // Quick tick/whoosh: rising filtered noise sweep + faint tick.
  noise(d, { start: t, dur: 0.11, peak: 0.14, type: "highpass", freq: 900, q: 0.7 });
  tone(d, { type: "triangle", freq: 520, glideTo: 900, start: t, dur: 0.09, peak: 0.12 });
}

function sfxMeeple(t: number, d: AudioNode): void {
  // Cute bright blip — little rising two-note.
  tone(d, { type: "square", freq: 660, start: t, dur: 0.09, peak: 0.16 });
  tone(d, { type: "square", freq: 990, start: t + 0.08, dur: 0.11, peak: 0.16 });
}

function sfxScore(t: number, d: AudioNode): void {
  // Warm ascending marimba-ish arpeggio chime.
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => {
    const st = t + i * 0.07;
    tone(d, { type: "triangle", freq: f, start: st, dur: 0.28, peak: 0.2, attack: 0.005 });
    // gentle sine overtone for a mallet-ish warmth
    tone(d, { type: "sine", freq: f * 2, start: st, dur: 0.14, peak: 0.05 });
  });
}

function sfxInvalid(t: number, d: AudioNode): void {
  // Gentle low "nope" buzz — soft, not harsh. Two-note downward wobble.
  tone(d, { type: "sine", freq: 200, glideTo: 150, start: t, dur: 0.16, peak: 0.28 });
  tone(d, { type: "sine", freq: 150, glideTo: 120, start: t + 0.13, dur: 0.16, peak: 0.24 });
}

function sfxButton(t: number, d: AudioNode): void {
  // Light UI click.
  noise(d, { start: t, dur: 0.03, peak: 0.14, type: "bandpass", freq: 2200, q: 1.5 });
  tone(d, { type: "sine", freq: 620, start: t, dur: 0.05, peak: 0.14 });
}

function sfxDraw(t: number, d: AudioNode): void {
  // Soft paper/card swish — filtered noise swell that opens then closes.
  if (!ctx || !noiseBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1200, t);
  filter.frequency.linearRampToValueAtTime(3600, t + 0.18);
  filter.Q.setValueAtTime(0.8, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.16, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  src.connect(filter).connect(g).connect(d);
  src.start(t);
  src.stop(t + 0.26);
  src.onended = () => {
    try {
      src.disconnect();
      filter.disconnect();
      g.disconnect();
    } catch {
      /* already gone */
    }
  };
}

function sfxVictory(t: number, d: AudioNode): void {
  // Triumphant little fanfare — a warm major run capped by a chord.
  const run = [392.0, 523.25, 659.25, 783.99]; // G4 C5 E5 G5
  run.forEach((f, i) => {
    const st = t + i * 0.1;
    tone(d, { type: "triangle", freq: f, start: st, dur: 0.22, peak: 0.22 });
    tone(d, { type: "sine", freq: f * 2, start: st, dur: 0.12, peak: 0.05 });
  });
  // Final held chord (C major) for a satisfying resolve.
  const chord = [523.25, 659.25, 783.99];
  const ct = t + 0.42;
  chord.forEach((f) => {
    tone(d, { type: "triangle", freq: f, start: ct, dur: 0.45, peak: 0.16, attack: 0.01 });
  });
}

function sfxHandoff(t: number, d: AudioNode): void {
  // Neutral, pleasant two-note chime.
  tone(d, { type: "sine", freq: 587.33, start: t, dur: 0.2, peak: 0.2 }); // D5
  tone(d, { type: "sine", freq: 880.0, start: t + 0.12, dur: 0.24, peak: 0.2 }); // A5
}

const SFX: Record<SfxName, (t: number, d: AudioNode) => void> = {
  place: sfxPlace,
  rotate: sfxRotate,
  meeple: sfxMeeple,
  score: sfxScore,
  invalid: sfxInvalid,
  button: sfxButton,
  draw: sfxDraw,
  victory: sfxVictory,
  handoff: sfxHandoff,
};

// ============================================================================
// Generative music — warm pentatonic lead + bass + occasional pad.
// Scheduled against the WebAudio clock via a lookahead scheduler.
// ============================================================================

/** A soft plucked lead voice with a little vibrato-free warmth. */
function musicLead(freq: number, at: number, dur: number, vol: number): void {
  if (!ctx || !musicBus) return;
  tone(musicBus, { type: "triangle", freq, start: at, dur, peak: vol, attack: 0.02 });
  tone(musicBus, { type: "sine", freq: freq * 2, start: at, dur: dur * 0.6, peak: vol * 0.25 });
}

/** A round, mellow bass note. */
function musicBass(freq: number, at: number, dur: number): void {
  if (!ctx || !musicBus) return;
  tone(musicBus, { type: "sine", freq, start: at, dur, peak: 0.5, attack: 0.03 });
  tone(musicBus, { type: "triangle", freq: freq * 2, start: at, dur: dur * 0.5, peak: 0.08 });
}

/** A slow, soft pad chord that swells and fades under everything. */
function musicPad(root: number, at: number, dur: number): void {
  if (!ctx || !musicBus) return;
  const voices = [root, root * 1.25, root * 1.5]; // root + major third + fifth
  voices.forEach((f) => {
    const osc = ctx!.createOscillator();
    const g = ctx!.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f * 2, at);
    osc.detune.setValueAtTime((Math.random() - 0.5) * 8, at); // gentle chorus
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.06, at + dur * 0.4); // slow swell
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(musicBus!);
    osc.start(at);
    osc.stop(at + dur + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* gone */
      }
    };
  });
}

/** Schedule everything that happens on a single step at time `at`. */
function scheduleStep(s: number, at: number): void {
  const barLen = 16; // steps per harmonic bar
  const posInBar = s % barLen;
  const chordIndex = Math.floor(s / barLen) % BASS_ROOTS.length;
  const root = BASS_ROOTS[chordIndex];

  // Bass: root on the downbeat, gentle fifth midway. Long, round notes.
  if (posInBar === 0) {
    musicBass(root, at, STEP_DUR * 8);
  } else if (posInBar === 8) {
    musicBass(root * 1.5, at, STEP_DUR * 6);
  }

  // Pad: swell once per bar, spanning the whole bar for a warm bed.
  if (posInBar === 0) {
    musicPad(root, at, STEP_DUR * barLen);
  }

  // Lead: a sparse, generative pentatonic melody. Play on some steps only,
  // biased toward on-beats, with gentle octave/register drift.
  const onBeat = posInBar % 2 === 0;
  const density = onBeat ? 0.55 : 0.18; // sparser off-beats = calmer feel
  if (Math.random() < density) {
    // Choose a scale degree, softly biased toward the current chord root.
    let idx = Math.floor(Math.random() * LEAD_SCALE.length);
    if (Math.random() < 0.4) idx = (chordIndex * 2) % LEAD_SCALE.length;
    const freq = LEAD_SCALE[idx];
    const vol = 0.16 + Math.random() * 0.06;
    musicLead(freq, at, STEP_DUR * (onBeat ? 1.6 : 1.0), vol);
  }
}

/** Lookahead scheduler loop — queues notes slightly ahead of the clock.
 *  This runs on setInterval (which keeps firing even when the tab is hidden),
 *  so it is also our safety net: if the page is not visible, suspend the audio
 *  context and stop queuing — music must never play off-screen. */
function schedulerTick(): void {
  if (!ctx) return;
  if (typeof document !== "undefined" && document.hidden) {
    if (ctx.state === "running") void ctx.suspend();
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
    nextNoteTime = ctx.currentTime + 0.12; // re-anchor after a suspend
  }
  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextNoteTime);
    nextNoteTime += STEP_DUR;
    step += 1;
  }
}

function startScheduler(): void {
  if (schedulerTimer !== null || !ctx) return;
  nextNoteTime = ctx.currentTime + 0.12; // small lead-in
  schedulerTick();
  schedulerTimer = window.setInterval(schedulerTick, LOOKAHEAD_MS);
}

function stopScheduler(): void {
  if (schedulerTimer !== null) {
    window.clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ============================================================================
// Public API
// ============================================================================

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Apply the current mute state to the master gain (ramped, no pops). */
function applyMute(): void {
  if (!ctx || !master) return;
  const target = muted ? 0.0001 : MASTER_VOL;
  ramp(master.gain, target, now(), 0.03);
}

export const audio: AudioApi = {
  init(): void {
    if (ctx) {
      // Already inited — just ensure we're resumed (gesture requirement).
      void ctx.resume();
      return;
    }
    const Ctor: AudioCtxCtor | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as unknown as WebkitWindow).webkitAudioContext;
    if (!Ctor) return; // no WebAudio support — stay a silent no-op

    ctx = new Ctor();

    master = ctx.createGain();
    sfxBus = ctx.createGain();
    musicBus = ctx.createGain();

    muted = loadMuted();
    master.gain.setValueAtTime(muted ? 0.0001 : MASTER_VOL, ctx.currentTime);
    sfxBus.gain.setValueAtTime(1.0, ctx.currentTime);
    musicBus.gain.setValueAtTime(MUSIC_VOL, ctx.currentTime);

    sfxBus.connect(master);
    musicBus.connect(master);
    master.connect(ctx.destination);

    // Build the shared 1s white-noise buffer once.
    const len = Math.floor(ctx.sampleRate * 1.0);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Safari/iOS: contexts often start suspended until a gesture resumes them.
    void ctx.resume();
  },

  play(name: SfxName): void {
    if (!ctx || !sfxBus || muted) return; // safe no-op before init / when muted
    // Resume opportunistically (helps if the gesture chain lapsed on iOS).
    if (ctx.state === "suspended") void ctx.resume();
    const voice = SFX[name];
    if (!voice) return;
    voice(now() + 0.001, sfxBus);
  },

  startMusic(): void {
    if (!ctx || musicPlaying) return;
    if (ctx.state === "suspended") void ctx.resume();
    musicPlaying = true;
    step = 0;
    startScheduler();
  },

  stopMusic(): void {
    if (!musicPlaying) return;
    musicPlaying = false;
    stopScheduler();
    // Notes already queued will simply fade out via their own envelopes.
  },

  setMuted(m: boolean): void {
    muted = m;
    saveMuted(m);
    applyMute();
    // Keep the scheduler clean: pause queuing while muted, resume after.
    if (muted) {
      stopScheduler();
    } else if (musicPlaying && ctx) {
      if (ctx.state === "suspended") void ctx.resume();
      // Re-anchor the clock so we don't dump a backlog of stale steps.
      nextNoteTime = ctx.currentTime + 0.12;
      startScheduler();
    }
  },

  isMuted(): boolean {
    return muted;
  },
};

// ---------------------------------------------------------------------------
// Page lifecycle — never let the looping music keep playing once the tab/panel
// is hidden or closed. Suspending the AudioContext halts ALL sound instantly;
// we resume when the page is shown again (only if music should be playing).
// ---------------------------------------------------------------------------
function suspendAll(): void {
  if (ctx && ctx.state === "running") void ctx.suspend();
}
function resumeIfPlaying(): void {
  if (ctx && musicPlaying && !muted && ctx.state === "suspended") void ctx.resume();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspendAll();
    else resumeIfPlaying();
  });
  // Fired when the page is being unloaded / bfcached (tab or preview closed).
  window.addEventListener("pagehide", () => {
    audio.stopMusic();
    suspendAll();
  });
}

// Dev-only accessor so tests can observe the AudioContext state.
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (audio as unknown as { _state(): string })._state = () =>
    `${ctx?.state ?? "none"}/music:${musicPlaying}`;
}

// Dev only: on hot-reload, tear down THIS module's audio so its scheduler and
// AudioContext can't keep looping in the background after it's replaced.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
if (hot) {
  hot.dispose(() => {
    try {
      stopScheduler();
      musicPlaying = false;
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    } catch {
      /* ignore teardown errors */
    }
  });
}
