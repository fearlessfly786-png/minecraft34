/**
 * RATFIRE game audio — Web Audio sound manager.
 *
 * The suite is the user's pick plus their uploaded gun cues:
 *   rain-loop   "Heavy storm rain loop" (mixkit #2400)      /public/sfx/
 *   night-loop  "Wind blowing ambience" (mixkit #2658 WAV)  /public/sfx/
 *              — the NIGHT ambience channel, faded in with the moon
 *   shoot       user-uploaded gun SHOOTING sfx       /public/sfx/shoot.mp3
 *   reload      user-uploaded gun RELOAD sfx         /public/sfx/reload.mp3
 *   jump        user-uploaded ATHLETIC JUMP sfx      /public/sfx/jump.mp3
 *   roar        "Giant monster roar" (mixkit #1972 WAV) — the 5-key emote
 *   ignition    user-uploaded CAR IGNITION sfx (mixkit #1535 WAV) — the
 *              jeep's engine start (key turn + starter crank + catch),
 *              fired by enterJeep on every mount path
 * (the pre-existing /sounds/running-forest.wav footstep loop lives in
 * page.tsx as a plain HTMLAudioElement; the mute toggle covers ALL.)
 *
 * Autoplay-policy-proof architecture: the AudioContext is created LAZILY
 * inside the FIRST user gesture (any click / key press — the F fire key
 * qualifies). A context born during a gesture starts 'running' in every
 * browser — no resume() gamble. The raw file data is fetched lazily on
 * that same first gesture (fetch itself needs no gesture, but deferring
 * the download keeps ~14MB of audio bytes out of RAM while the player
 * idles in the lobby — decode timing relative to the consuming context
 * is unchanged). One-shots fired before the graph is ready only warm the
 * init — the next press plays. A missing file only silences its own cue;
 * audio can never break the game.
 */

import { setGlobalMuted } from './muteState';

export interface GameAudioHandle {
  /** Storm intensity 0..1 — drives the rain loop. */
  setRain(intensity: number): void;
  /** Night factor 0..1 (moon height) — fades the night wind loop in/out. */
  setNight(intensity: number): void;
  /** Ensure the context exists + is running (called from user gestures). */
  resume(): void;
  /** One-shot cues: gun fire per attack clip, gun draw on weapon switch,
   *  the F-key fire cycle (shot -> reload) on every attack press, the
   *  Space-key jump, and the 5-key monster roar. shootThenReload schedules
   *  the reload `reloadDelaySeconds` after the bang so BOTH cues live
   *  inside one attack-clip duration. roar(fitSeconds) trims the long roar
   *  file so it ends exactly with the flip animation. */
  shoot(): void;
  reload(): void;
  jump(): void;
  roar(fitSeconds?: number): void;
  /** Jeep engine start (user-uploaded mixkit ignition WAV) — fires when
   *  the player mounts the vehicle (E key, touch button, any path). */
  ignition(): void;
  shootThenReload(reloadDelaySeconds?: number): void;
  /** Loot chest opened: a short synthesized two-note coin chime
   *  (B5 -> E6) — no audio file needed, covered by the mute toggle. */
  pickup(): void;
  /** Lightning thunder: a synthesized rolling rumble (filtered noise,
   *  three slow swells over ~3s) scheduled `delaySeconds` from now —
   *  distance-proportional so far bolts thunder later. No audio file;
   *  covered by the master mute like every other cue. */
  thunder(delaySeconds?: number): void;
  /** Missile lock-on radar cue, synthesized: `final=false` is the short
   *  pinging blip the HUD repeats with an accelerating rate while the
   *  reticle is tightening; `final=true` is the higher solid tone that
   *  stamps the launch. No audio file; covered by the master mute. */
  lockBlip(final?: boolean): void;
  /** WIDOW web shot: a synthesized "thwip" — a band-passed noise sweep
   *  (silk hiss, 3.4kHz→750Hz over 140ms) plus a descending triangle
   *  pluck (the strand snapping taut). No audio file; covered by the
   *  master mute like every other cue. */
  webShot(): void;
  /** Silk anchor splat: a soft low noise puff when a web strand sticks
   *  to the world. No audio file; covered by the master mute. */
  webStick(): void;
  /** Orb-web weave shimmer: five soft rising sine pings + an airy
   *  high-swish while the anchor blooms into its radial web. No audio
   *  file; covered by the master mute. */
  webWeave(): void;
  /** DART's piston engine, synthesized live (no audio file): a pair of
   *  detuned sawtooths + a sub sine through a lowpass. `on=true` ramps
   *  the drone in, `throttle` (0..1) rides EVERY frame while the player
   *  flies — pitch and volume follow the lever like a real piston engine.
   *  Covered by the master mute like every other cue. */
  setPlaneEngine(on: boolean, throttle: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Debug/verification snapshot (surfaced on window.__sfx). */
  debug(): {
    ctxState: string;
    loaded: string[];
    muted: boolean;
    gains: Record<string, number>;
    oneshots: Record<string, number>;
    resumeError: string | null;
    rainTarget: number;
    nightTarget: number;
    /** Delay (s) scheduled between the last shot and its chained reload. */
    reloadDelay: number;
    /** Portion (s) of the roar file the last 5-press played (fit to flip). */
    roarFit: number;
    /** DART engine synth state (on + last throttle request). */
    planeEngine: { on: boolean; throttle: number };
  };
}

const RAIN_FILE = 'rain-loop.mp3';
const RAIN_GAIN = 0.75;
const NIGHT_FILE = 'night-loop.wav';
const NIGHT_GAIN = 0.38; // lightly reduced per user (was 0.45)
const ONE_SHOTS = {
  shoot: { file: 'shoot.mp3', gain: 0.6 },
  reload: { file: 'reload.mp3', gain: 0.7 },
  jump: { file: 'jump.mp3', gain: 0.55 },
  roar: { file: 'roar.wav', gain: 0.7 },
  ignition: { file: 'car-ignition.wav', gain: 0.8 },
} as const;

/** Fallback gap between the shot and its follow-up reload cue. page.tsx
 *  overrides this per fire cycle with attackClipDuration * 0.4 (the attack
 *  clip is 0.8s -> 0.32s), which lands the reload's audible clicks (first
 *  ~0.41s of the file) BEFORE the attack animation finishes — both cues
 *  start AND finish inside one shooting animation. */
const DEFAULT_RELOAD_DELAY = 0.4;

const MUTE_PREF_KEY = 'ratfire-muted';

let singleton: GameAudioHandle | null = null;
let creating: Promise<GameAudioHandle> | null = null;

/** Lazily create (once) the game audio manager. Safe to call anywhere. */
export function getGameAudio(): Promise<GameAudioHandle> {
  if (singleton) return Promise.resolve(singleton);
  if (!creating) creating = createGameAudio();
  return creating;
}

async function createGameAudio(): Promise<GameAudioHandle> {
  // ---- raw file data, fetched lazily on the FIRST user gesture ----
  // (fetch needs no gesture, but starting the downloads here instead of
  // at manager creation keeps the compressed bytes out of RAM while the
  // player hangs out in the lobby; every consumer below awaits the same
  // promises as before, so decode order and behavior are identical)
  let prefetch: Map<string, Promise<ArrayBuffer | null>> | null = null;
  const files: Array<[string, string]> = [
    ['rain-loop', RAIN_FILE],
    ['night-loop', NIGHT_FILE],
    ['shoot', ONE_SHOTS.shoot.file],
    ['reload', ONE_SHOTS.reload.file],
    ['jump', ONE_SHOTS.jump.file],
    ['roar', ONE_SHOTS.roar.file],
    ['ignition', ONE_SHOTS.ignition.file],
  ];
  function startPrefetch(): Map<string, Promise<ArrayBuffer | null>> {
    if (!prefetch) {
      prefetch = new Map();
      for (const [key, file] of files) {
        prefetch.set(
          key,
          fetch(`/sfx/${file}`)
            .then((res) => (res.ok ? res.arrayBuffer() : null))
            .catch(() => null)
        );
      }
    }
    return prefetch;
  }

  // ---- live audio graph (built inside the first user gesture) ----
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let rainGain: GainNode | null = null;
  let nightGain: GainNode | null = null;
  const oneShotBuffers = new Map<string, AudioBuffer>();
  let lastRainTarget = -1;
  let rainTarget = 0;
  let lastNightTarget = -1;
  let nightTarget = 0;
  const oneshotCounts: Record<string, number> = {};
  let resumeError: string | null = null;
  let initPromise: Promise<void> | null = null;

  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_PREF_KEY) === '1';
  } catch {
    /* private mode etc. */
  }
  // seed the global bus with the persisted preference so every subscriber
  // (current and future) starts in the same state as this master gain
  setGlobalMuted(muted);

  /** Build the AudioContext + graph. MUST first be called from a gesture —
   *  a context born mid-gesture starts 'running' in every browser. */
  function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        // kick off (or reuse) the raw-data downloads for this gesture
        const prefetch = startPrefetch();
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const theCtx = new Ctx(); // born running (gesture-driven)
        ctx = theCtx;

        master = theCtx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(theCtx.destination);

        // decode rain (loop) from the prefetched data — the raw file
        // bytes are released right after so they never stay pinned
        const rainData = await prefetch.get('rain-loop');
        prefetch.delete('rain-loop');
        if (rainData) {
          const buf = await theCtx.decodeAudioData(rainData);
          const src = theCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          rainGain = theCtx.createGain();
          rainGain.gain.value = 0;
          src.connect(rainGain).connect(master);
          src.start();
        }

        // decode the night wind (loop) — faded in by the moon, not the storm
        const nightData = await prefetch.get('night-loop');
        prefetch.delete('night-loop');
        if (nightData) {
          const buf = await theCtx.decodeAudioData(nightData);
          const src = theCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          nightGain = theCtx.createGain();
          nightGain.gain.value = 0;
          src.connect(nightGain).connect(master);
          src.start();
        }

        // decode the gun one-shots (each raw buffer is consumed exactly
        // once — decodeAudioData detaches it, so no slice copy needed
        // and no compressed bytes linger after decode)
        for (const name of Object.keys(ONE_SHOTS) as Array<
          keyof typeof ONE_SHOTS
        >) {
          const data = await prefetch.get(name);
          prefetch.delete(name);
          if (data) {
            oneShotBuffers.set(
              name,
              await theCtx.decodeAudioData(data)
            );
          }
        }
        // drop whatever is left (failed fetches resolved to null) so
        // no raw audio bytes outlive their decoded AudioBuffers
        prefetch.clear();
      } catch (err) {
        resumeError = err instanceof Error ? err.message : String(err);
      }
    })();
    return initPromise;
  }

  /** Create + schedule one cue at `when` seconds from now (sample-accurate
   *  on real hardware; counted for the debug snapshot). */
  function playOneShot(name: keyof typeof ONE_SHOTS, when = 0): void {
    const buf = oneShotBuffers.get(name);
    if (!ctx || !buf || !master) return;
    oneshotCounts[name] = (oneshotCounts[name] ?? 0) + 1;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.12;
      const gain = ctx.createGain();
      gain.gain.value = ONE_SHOTS[name].gain;
      src.connect(gain).connect(master);
      src.start(ctx.currentTime + when);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Ready-check shared by the cue entry points; warms the init if the
   *  graph is still building (the NEXT press then plays). */
  function graphReady(): boolean {
    const buf = oneShotBuffers.get('shoot');
    if (!ctx || !buf || !master) {
      void init();
      return false;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    return true;
  }

  /** Fire a single one-shot cue. */
  function fire(name: keyof typeof ONE_SHOTS): void {
    if (!graphReady()) return;
    playOneShot(name);
  }

  /** F-key fire cycle (user request): the shooting SFX plays first and the
   *  reload SFX follows within the SAME attack-clip duration — the reload
   *  starts at `reloadDelaySeconds` (page.tsx derives it from the real
   *  attack clip length) so its clicks finish before the animation ends. */
  let lastReloadDelay = DEFAULT_RELOAD_DELAY;
  function shootThenReload(reloadDelaySeconds?: number): void {
    if (!graphReady()) return;
    const delay = Math.max(
      0,
      reloadDelaySeconds ?? DEFAULT_RELOAD_DELAY
    );
    lastReloadDelay = delay;
    playOneShot('shoot');
    if (oneShotBuffers.has('reload')) {
      playOneShot('reload', delay);
    }
  }

  /** 5-key monster roar, TRIMMED to `fitSeconds` (the flip clip's length):
   *  src.start's third arg plays only the first `fit` seconds of the file
   *  and a linear gain ease-out over the last 0.15s makes the cut inaudible
   *  — the roar ends exactly with the animation. Playback rate stays 1.0 so
   *  the fit is exact (no chipmunk speed-up). */
  let lastRoarFit = 0;
  function roar(fitSeconds?: number): void {
    if (!graphReady()) return;
    const buf = oneShotBuffers.get('roar');
    if (!ctx || !buf || !master) return;
    oneshotCounts.roar = (oneshotCounts.roar ?? 0) + 1;
    const fit =
      fitSeconds && fitSeconds > 0.2
        ? Math.min(fitSeconds, buf.duration)
        : buf.duration;
    lastRoarFit = Number(fit.toFixed(3));
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      const g = ONE_SHOTS.roar.gain;
      const t0 = ctx.currentTime;
      if (fit < buf.duration - 0.05) {
        gain.gain.setValueAtTime(g, t0);
        gain.gain.setValueAtTime(g, t0 + fit - 0.15);
        gain.gain.linearRampToValueAtTime(0.0001, t0 + fit);
      } else {
        gain.gain.value = g;
      }
      src.connect(gain).connect(master);
      src.start(t0, 0, fit);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Loot-chest coin chime: two quick sine notes (B5 -> E6) with fast
   *  exponential decays — the classic "coin pickup" arc, synthesized in
   *  the graph (no asset) so it always exists and the master mute covers
   *  it like every other cue. */
  function pickup(): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.pickup = (oneshotCounts.pickup ?? 0) + 1;
    try {
      const t0 = ctx.currentTime;
      const note = (
        freq: number,
        start: number,
        dur: number,
        peak: number
      ) => {
        const osc = ctx!.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const gain = ctx!.createGain();
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        osc.connect(gain).connect(master!);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur + 0.02);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
      };
      note(987.77, 0, 0.11, 0.32); // B5
      note(1318.51, 0.075, 0.38, 0.3); // E6
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Shared white-noise buffer (built lazily once the ctx exists) — the
   *  raw material for every synthesized storm cue (thunder). */
  let noiseBuf: AudioBuffer | null = null;
  function noise(): AudioBuffer {
    if (noiseBuf && ctx) return noiseBuf;
    const len = ctx!.sampleRate * 1.2;
    noiseBuf = ctx!.createBuffer(1, len, ctx!.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  /** Rolling thunder, synthesized: slowed white noise through a deep
   *  lowpass, shaped into three overlapping swells (~3s) — reads as a
   *  distant rumble rolling over the hills rather than a single bang. */
  function thunder(delaySeconds?: number): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.thunder = (oneshotCounts.thunder ?? 0) + 1;
    try {
      const t0 = ctx.currentTime + Math.max(0, delaySeconds ?? 0);
      const src = ctx.createBufferSource();
      src.buffer = noise();
      src.loop = true;
      src.playbackRate.value = 0.32; // stretched -> deep rumble
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 95;
      lp.Q.value = 0.4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      // three rolling swells, each softer than the last peak
      gain.gain.linearRampToValueAtTime(0.5, t0 + 0.14);
      gain.gain.linearRampToValueAtTime(0.16, t0 + 0.65);
      gain.gain.linearRampToValueAtTime(0.46, t0 + 1.15);
      gain.gain.linearRampToValueAtTime(0.14, t0 + 1.95);
      gain.gain.linearRampToValueAtTime(0.3, t0 + 2.5);
      gain.gain.linearRampToValueAtTime(0.0001, t0 + 3.2);
      src.connect(lp).connect(gain).connect(master);
      src.start(t0);
      src.stop(t0 + 3.3);
      src.onended = () => {
        src.disconnect();
        lp.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Lock-on blip: a hard radar ping (square wave through a narrow
   *  bandpass feel via two stacked sines) — `final` raises the pitch and
   *  stretches it into the solid tone that rides the launch. */
  function lockBlip(final?: boolean): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.lockblip = (oneshotCounts.lockblip ?? 0) + 1;
    try {
      const t0 = ctx.currentTime;
      const freq = final ? 1244.5 : 830;
      const dur = final ? 0.3 : 0.07;
      const peak = final ? 0.3 : 0.17;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (!final) osc.frequency.exponentialRampToValueAtTime(freq * 1.18, t0 + dur);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  // ---- DART's piston engine (persistent synth, built lazily) ----
  // Two detuned sawtooths beat against each other for the rough piston
  // texture, a sub sine carries the body, and one lowpass tames the buzz.
  // The gain stays connected to master, so the speaker mute covers it.
  let engineA: OscillatorNode | null = null;
  let engineB: OscillatorNode | null = null;
  let engineSub: OscillatorNode | null = null;
  let engineFilter: BiquadFilterNode | null = null;
  let engineGain: GainNode | null = null;
  let engineOn = false;
  let engineThr = 0;
  let lastEngineKey = '';
  function buildEngine(): void {
    if (!ctx || !master || engineA) return;
    try {
      engineA = ctx.createOscillator();
      engineA.type = 'sawtooth';
      engineB = ctx.createOscillator();
      engineB.type = 'sawtooth';
      engineSub = ctx.createOscillator();
      engineSub.type = 'sine';
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 260;
      engineFilter.Q.value = 0.6;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      engineA.connect(engineFilter);
      engineB.connect(engineFilter);
      engineSub.connect(engineFilter);
      engineFilter.connect(engineGain).connect(master);
      engineA.start();
      engineB.start();
      engineSub.start();
    } catch {
      engineA = null; // synth failed — the game stays silent, never breaks
    }
  }
  function setPlaneEngine(on: boolean, throttle: number): void {
    engineOn = on;
    engineThr = Math.min(1, Math.max(0, throttle));
    if (!ctx || !master) {
      void init(); // warm the graph; the next frame's call lands
      return;
    }
    if (on && !engineA) buildEngine();
    if (!engineA || !engineGain || !engineFilter) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    // throttle -> engine note: idle ~46 Hz, full boost ~104 Hz (the classic
    // piston drone rising with the lever); skip identical writes per frame
    const thr = engineThr;
    const key = `${on ? 1 : 0}:${Math.round(thr * 50)}`;
    if (key === lastEngineKey) return;
    lastEngineKey = key;
    try {
      const t = ctx.currentTime;
      const base = 46 + thr * 58;
      engineA!.frequency.setTargetAtTime(base, t, 0.12);
      engineB!.frequency.setTargetAtTime(base * 1.008, t, 0.12); // slow beat
      engineSub!.frequency.setTargetAtTime(base * 0.5, t, 0.12);
      engineFilter!.frequency.setTargetAtTime(240 + thr * 520, t, 0.15);
      engineGain!.gain.setTargetAtTime(
        on ? 0.05 + thr * 0.075 : 0.0001,
        t,
        on ? 0.35 : 0.25 // spool up / spin down — never a click
      );
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** WIDOW's THWIP, synthesized: a fast band-passed noise sweep reads as
   *  silk hissing out of the spinneret while a triangle pluck falling
   *  1.5kHz→320Hz stamps the strand going taut. */
  function webShot(): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.webshot = (oneshotCounts.webshot ?? 0) + 1;
    try {
      const t0 = ctx.currentTime;
      // silk hiss: band-passed noise sweeping down
      const src = ctx.createBufferSource();
      src.buffer = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(3400, t0);
      bp.frequency.exponentialRampToValueAtTime(750, t0 + 0.14);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.42, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      src.connect(bp).connect(gain).connect(master);
      src.start(t0);
      src.stop(t0 + 0.18);
      src.onended = () => {
        src.disconnect();
        bp.disconnect();
        gain.disconnect();
      };
      // taut-strand pluck: falling triangle
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1500, t0 + 0.02);
      osc.frequency.exponentialRampToValueAtTime(320, t0 + 0.13);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t0 + 0.02);
      g2.gain.exponentialRampToValueAtTime(0.16, t0 + 0.035);
      g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(g2).connect(master);
      osc.start(t0 + 0.02);
      osc.stop(t0 + 0.22);
      osc.onended = () => {
        osc.disconnect();
        g2.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Soft splat when a strand anchors: a short low-passed noise puff. */
  function webStick(): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.webstick = (oneshotCounts.webstick ?? 0) + 1;
    try {
      const t0 = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      src.connect(lp).connect(gain).connect(master);
      src.start(t0);
      src.stop(t0 + 0.13);
      src.onended = () => {
        src.disconnect();
        lp.disconnect();
        gain.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  /** Orb-web weave shimmer: soft rising sine pings (the spokes/rings
   *  rippling out) over one airy band-passed swish. */
  function webWeave(): void {
    if (!ctx || !master) {
      void init();
      return;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    oneshotCounts.webweave = (oneshotCounts.webweave ?? 0) + 1;
    try {
      const t0 = ctx.currentTime;
      // airy swish as the silk stretches across the spokes
      const src = ctx.createBufferSource();
      src.buffer = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(900, t0);
      bp.frequency.exponentialRampToValueAtTime(3800, t0 + 0.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      src.connect(bp).connect(gain).connect(master);
      src.start(t0);
      src.stop(t0 + 0.6);
      src.onended = () => {
        src.disconnect();
        bp.disconnect();
        gain.disconnect();
      };
      // rising pings — one per ring of the spiral weaving in
      const pings = [880, 1175, 1568, 2093, 2637];
      for (let i = 0; i < pings.length; i++) {
        const at = t0 + 0.1 + i * 0.16;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = pings[i];
        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(0.0001, at);
        g2.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
        g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
        osc.connect(g2).connect(master);
        osc.start(at);
        osc.stop(at + 0.2);
        osc.onended = () => {
          osc.disconnect();
          g2.disconnect();
        };
      }
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  // ---- ANY first interaction builds the context (born running) ----
  window.addEventListener('pointerdown', () => void init());
  window.addEventListener('keydown', () => void init());

  singleton = {
    resume() {
      void init();
    },
    setRain(intensity) {
      const target = RAIN_GAIN * Math.min(1, Math.max(0, intensity));
      rainTarget = Number(target.toFixed(3));
      if (!rainGain || Math.abs(lastRainTarget - target) < 0.004) return;
      lastRainTarget = target;
      rainGain.gain.setTargetAtTime(target, ctx!.currentTime, 0.5);
    },
    setNight(intensity) {
      const target = NIGHT_GAIN * Math.min(1, Math.max(0, intensity));
      nightTarget = Number(target.toFixed(3));
      if (!nightGain || Math.abs(lastNightTarget - target) < 0.004) return;
      lastNightTarget = target;
      // slow ~1s ambience fade so dusk/dawn crossfades feel natural
      nightGain.gain.setTargetAtTime(target, ctx!.currentTime, 1.0);
    },
    shoot: () => fire('shoot'),
    reload: () => fire('reload'),
    jump: () => fire('jump'),
    ignition: () => fire('ignition'),
    roar: (fitSeconds?: number) => roar(fitSeconds),
    // forward the delay — an argless arrow here would silently drop it
    shootThenReload: (delay?: number) => shootThenReload(delay),
    pickup: () => pickup(),
    thunder: (delaySeconds?: number) => thunder(delaySeconds),
    lockBlip: (final?: boolean) => lockBlip(final),
    webShot: () => webShot(),
    webStick: () => webStick(),
    webWeave: () => webWeave(),
    setPlaneEngine: (on: boolean, throttle: number) =>
      setPlaneEngine(on, throttle),
    setMuted(next) {
      muted = next;
      // one flip silences EVERY producer — including the ones with their
      // own AudioContexts (rain bed) that this master gain can't reach
      setGlobalMuted(next);
      try {
        localStorage.setItem(MUTE_PREF_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (master && ctx) {
        master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.05);
      }
    },
    isMuted: () => muted,
    debug() {
      return {
        ctxState: ctx ? ctx.state : 'uncreated',
        loaded: [
          ...(rainGain ? ['rain-loop'] : []),
          ...(nightGain ? ['night-loop'] : []),
          ...[...oneShotBuffers.keys()],
        ],
        muted,
        gains:
          rainGain && nightGain && ctx
            ? {
                'rain-loop': Number(rainGain.gain.value.toFixed(3)),
                'night-loop': Number(nightGain.gain.value.toFixed(3)),
              }
            : {},
        oneshots: { ...oneshotCounts },
        resumeError,
        rainTarget,
        nightTarget,
        reloadDelay: lastReloadDelay,
        roarFit: lastRoarFit,
        planeEngine: { on: engineOn, throttle: Number(engineThr.toFixed(2)) },
      };
    },
  };

  return singleton;
}
