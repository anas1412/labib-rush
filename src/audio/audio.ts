// Game audio engine (AudioEngine contract, src/core/types.ts). All sound is synthesised at runtime
// (see sfx.ts, music.ts, ambience.ts): no audio files to download.
//
// The AudioContext is created on the first unlock() (a user gesture), so browsers never block it.
// Calls made before that are no-ops, except that startMusic/startAmbience/settings are remembered
// and applied on unlock. Pause fades the game buses and freezes the music/ambience schedulers; the UI
// bus stays live so menu clicks still sound. A hidden tab suspends the whole context.
import type { Vector3 } from 'three';
import { DEFAULT_SETTINGS, type AudioEngine, type SfxName, type Settings } from '../core/types';
import { Ambience } from './ambience';
import { gain } from './dsp';
import { createMixer, type Mixer } from './mixer';
import { Music } from './music';
import { LEVEL, MIN_GAP, SFX, WET } from './sfx';

const LOOKAHEAD = 0.2; // s scheduled ahead of the clock
const TICK_MS = 40;
const RAMP = 0.05; // time constant for volume changes (no zipper noise / clicks)
/** Ambience sits under everything: fraction of the SFX volume. */
const AMBIENCE_LEVEL = 0.55;
const UI_SOUNDS = new Set<SfxName>(['uiClick', 'uiHover', 'uiBack']);
/** Positional sounds. Honks use HRTF (the brief asks for it); the rest cheap equal-power panning. */
const HRTF = new Set<SfxName>(['honk']);

/** Plays one sound into the mix at time t. Shared with the offline renders in dev/audio.ts. */
export function triggerSfx(mix: Mixer, name: SfxName, t: number, pitch = 1, volume = 1, dest?: AudioNode): void {
  const c = mix.ctx;
  const out = dest ?? (UI_SOUNDS.has(name) ? mix.ui : mix.sfx);
  const g = gain(c, volume * (LEVEL[name] ?? 1), out);
  const wet = WET[name];
  if (wet) g.connect(gain(c, wet, mix.reverb));
  SFX[name](c, g, t, pitch);
}

export function createAudio(): AudioEngine {
  let ctx: AudioContext | null = null;
  let mix: Mixer | null = null;
  let music: Music | null = null;
  let amb: Ambience | null = null;
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let paused = false;
  let wantMusic = false;
  let wantAmbience = false;
  let menuMusic = false;
  let intensity = 0;
  const lastPlayed = new Map<SfxName, number>();

  const ramp = (p: AudioParam, v: number, tau = RAMP) => {
    if (!ctx) return;
    p.cancelScheduledValues(ctx.currentTime);
    p.setTargetAtTime(v, ctx.currentTime, tau);
  };

  function applySettings(): void {
    if (!mix) return;
    // perceptual (squared) volume curves
    const m = settings.musicVolume ** 2, s = settings.sfxVolume ** 2;
    ramp(mix.master.gain, settings.muted ? 0 : 1);
    ramp(mix.music.gain, m);
    ramp(mix.sfx.gain, s);
    ramp(mix.ambience.gain, s * AMBIENCE_LEVEL);
    ramp(mix.ui.gain, s);
  }

  function tick(): void {
    if (!ctx || ctx.state !== 'running') return;
    const until = ctx.currentTime + LOOKAHEAD;
    music?.schedule(until);
    amb?.schedule(until);
  }

  function onVisibility(): void {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else void ctx.resume();
  }

  addEventListener('ui:click', (e: Event) => {
    const kind = (e as CustomEvent<{ kind?: string }>).detail?.kind;
    engine.play(kind === 'hover' ? 'uiHover' : kind === 'back' ? 'uiBack' : 'uiClick');
  });

  const engine: AudioEngine = {
    unlock() {
      if (!ctx) {
        try {
          ctx = new AudioContext({ latencyHint: 'interactive' });
        } catch {
          return; // no WebAudio: the game stays silent
        }
        mix = createMixer(ctx);
        music = new Music(ctx, mix.music, mix.reverb);
        amb = new Ambience(ctx, mix.ambience, mix.reverb);
        music.setMenu(menuMusic);
        music.setIntensity(intensity);
        applySettings();
        // iOS only fully unlocks once a source has started inside the gesture
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        silent.connect(ctx.destination);
        silent.start();
        window.setInterval(tick, TICK_MS); // lives as long as the page (one engine per game)
        document.addEventListener('visibilitychange', onVisibility);
        if (wantMusic) music.start();
        if (wantAmbience) amb.start();
        if (paused) engine.setPaused(true);
      }
      if (ctx.state !== 'running' && !document.hidden) void ctx.resume();
    },

    setSettings(s) {
      settings = { ...s };
      applySettings();
    },

    play(name, opts) {
      // 'suspended' right after unlock(): resume() is still pending, and a sound scheduled now starts
      // as soon as it resolves (so the click that unlocked audio is heard). A hidden tab stays silent.
      if (!ctx || !mix || ctx.state === 'closed' || document.hidden) return;
      const ui = UI_SOUNDS.has(name);
      if (paused && !ui) return;
      const now = ctx.currentTime;
      const gap = MIN_GAP[name] ?? 0.02;
      if (now - (lastPlayed.get(name) ?? -1) < gap) return;
      lastPlayed.set(name, now);
      let dest: AudioNode | undefined;
      const p = opts?.position;
      if (p && !ui) {
        const panner = new PannerNode(ctx, {
          panningModel: HRTF.has(name) ? 'HRTF' : 'equalpower',
          distanceModel: 'inverse',
          refDistance: 7,
          maxDistance: 250,
          rolloffFactor: 1.2,
          positionX: p.x, positionY: p.y, positionZ: p.z,
        });
        panner.connect(mix.sfx);
        dest = panner;
      }
      triggerSfx(mix, name, now + 0.005, opts?.pitch ?? 1, opts?.volume ?? 1, dest);
    },

    setListener(position: Vector3, forward: Vector3) {
      if (!ctx) return;
      const l = ctx.listener;
      if (l.positionX) {
        l.positionX.value = position.x; l.positionY.value = position.y; l.positionZ.value = position.z;
        l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      } else {
        // Firefox: AudioParam-less listener
        l.setPosition(position.x, position.y, position.z);
        l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
      }
    },

    startMusic() {
      wantMusic = true;
      if (music && !music.isPlaying) music.start();
    },

    stopMusic(fadeSec = 1) {
      wantMusic = false;
      music?.stop(fadeSec);
    },

    setMusicIntensity(v) {
      intensity = v;
      music?.setIntensity(v);
    },

    setMenuMusic(on) {
      menuMusic = on;
      music?.setMenu(on);
    },

    startAmbience() {
      wantAmbience = true;
      amb?.start();
    },

    stopAmbience() {
      wantAmbience = false;
      amb?.stop();
    },

    setPaused(p) {
      paused = p;
      if (!mix) return;
      ramp(mix.game.gain, p ? 0 : 1, p ? 0.03 : 0.08);
      music?.setPaused(p);
      amb?.setPaused(p);
    },
  };
  return engine;
}
