// MinusOne mixer: runs on the audio thread.
// Holds every stem as 16-bit PCM, mixes them with per-stem gains, loops a region,
// and (when speed or key are changed) time-stretches the mix with SoundTouch.
import { SoundTouch } from './vendor/soundtouch.js';

const CHUNK = 2048;            // frames fed to SoundTouch per step
const AHEAD = 6144;            // frames of stretched audio kept ready
const INV = 1 / 32768;

class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];           // [{L, R}] Int16Array
    this.length = 0;
    this.gainT = [];           // target gains
    this.gainC = [];           // current (smoothed) gains
    this.peaks = [];
    this.master = 1;
    this.masterC = 1;
    this.playing = false;
    this.read = 0;             // read head in source frames
    this.shown = 0;            // position reported to the UI
    this.loop = { on: false, a: 0, b: 0 };
    this.tempo = 1;
    this.pitch = 0;
    this.st = null;
    this.tmp = new Float32Array(CHUNK * 2);
    this.out = new Float32Array(256);
    this.reportEvery = Math.round(sampleRate / 30);
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get stretching() { return this.tempo !== 1 || this.pitch !== 0; }

  onMessage(m) {
    switch (m.type) {
      case 'reset':
        this.stems = []; this.length = 0; this.playing = false; this.read = this.shown = 0;
        this.loop = { on: false, a: 0, b: 0 };
        break;
      case 'stem':
        this.stems[m.index] = { L: m.left, R: m.right };
        this.length = Math.max(this.length, m.left.length);
        this.gainT[m.index] = this.gainC[m.index] = m.gain ?? 1;
        this.peaks[m.index] = 0;
        break;
      case 'gains':
        m.gains.forEach((g, i) => { this.gainT[i] = g; });
        break;
      case 'master': this.master = m.value; break;
      case 'play':
        if (this.read >= this.length) this.seekTo(this.loop.on ? this.loop.a : 0);
        this.playing = true;
        break;
      case 'pause': this.playing = false; this.report(true); break;
      case 'seek': this.seekTo(Math.round(m.time * sampleRate)); this.report(true); break;
      case 'loop':
        this.loop = { on: m.on, a: Math.round(m.a * sampleRate), b: Math.round(m.b * sampleRate) };
        if (this.loop.on && (this.shown < this.loop.a || this.shown >= this.loop.b)) this.seekTo(this.loop.a);
        break;
      case 'tempo': this.setStretch(m.value, this.pitch); break;
      case 'pitch': this.setStretch(this.tempo, m.value); break;
    }
  }

  setStretch(tempo, pitch) {
    const was = this.stretching;
    const pos = this.shown;
    this.tempo = tempo; this.pitch = pitch;
    if (this.stretching) {
      if (!this.st) {
        this.st = new SoundTouch();
        this.st.stretch.setParameters(sampleRate, 0, 0, 8);
      }
      this.st.tempo = tempo;
      this.st.pitchSemitones = pitch;
      if (!was) this.seekTo(pos);
    } else if (was) {
      this.seekTo(pos);
    }
  }

  seekTo(frame) {
    frame = Math.max(0, Math.min(frame, this.length));
    this.read = this.shown = frame;
    if (this.st) this.st.clear();
  }

  // Mix `frames` source frames starting at the read head into L/R (or interleaved) output.
  mix(outL, outR, frames, interleaved) {
    const n = this.stems.length;
    let written = 0;
    while (written < frames) {
      let end = this.length;
      if (this.loop.on && this.loop.b > this.loop.a) {
        if (this.read >= this.loop.b || this.read < this.loop.a) this.read = this.loop.a;   // wrap
        end = this.loop.b;
      }
      const take = Math.min(frames - written, end - this.read);
      if (take <= 0) break;
      for (let i = 0; i < take; i++) {
        if (interleaved) { outL[(written + i) * 2] = 0; outL[(written + i) * 2 + 1] = 0; }
        else { outL[written + i] = 0; outR[written + i] = 0; }
      }
      for (let s = 0; s < n; s++) {
        const stem = this.stems[s];
        if (!stem) continue;
        const g0 = this.gainC[s], g1 = this.gainT[s];
        if (g0 === 0 && g1 === 0) continue;
        const L = stem.L, R = stem.R, base = this.read;
        const step = (g1 - g0) / take;
        let g = g0, peak = this.peaks[s];
        for (let i = 0; i < take; i++) {
          const idx = base + i;
          const l = idx < L.length ? L[idx] * INV * g : 0;
          const r = idx < R.length ? R[idx] * INV * g : 0;
          if (interleaved) { outL[(written + i) * 2] += l; outL[(written + i) * 2 + 1] += r; }
          else { outL[written + i] += l; outR[written + i] += r; }
          const a = l > 0 ? l : -l;
          if (a > peak) peak = a;
          g += step;
        }
        this.peaks[s] = peak;
        this.gainC[s] = g1;
      }
      this.read += take;
      written += take;
    }
    return written;
  }

  feed() {
    const got = this.mix(this.tmp, null, CHUNK, true);
    if (got > 0) {
      this.st.inputBuffer.putSamples(this.tmp, 0, got);
      this.st.process();
    }
    return got;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const frames = L.length;
    if (!this.playing || this.length === 0) {
      L.fill(0); if (R !== L) R.fill(0);
      this.decayPeaks();
      return true;
    }

    if (!this.stretching) {
      const got = this.mix(L, R, frames, false);
      if (got < frames) { L.fill(0, got); R.fill(0, got); }
      this.shown = this.read;
      if (got === 0) return this.finish();
    } else {
      const ob = this.st.outputBuffer;
      let guard = 0;
      while (ob.frameCount < frames && guard++ < 8) {
        if (this.feed() === 0) break;
      }
      if (ob.frameCount < AHEAD) this.feed();          // stay a little ahead, one step per block
      const n = Math.min(frames, ob.frameCount);
      if (this.out.length < n * 2) this.out = new Float32Array(n * 2);
      ob.extract(this.out, 0, n);
      ob.receive(n);
      for (let i = 0; i < n; i++) { L[i] = this.out[i * 2]; R[i] = this.out[i * 2 + 1]; }
      if (n < frames) { L.fill(0, n); R.fill(0, n); }
      this.shown += n * this.tempo;
      if (this.loop.on && this.loop.b > this.loop.a && this.shown >= this.loop.b) {
        this.shown = this.loop.a + (this.shown - this.loop.b);
      }
      if (n === 0 && this.read >= this.length) return this.finish();
    }

    // master gain (smoothed)
    const m0 = this.masterC, m1 = this.master, ms = (m1 - m0) / frames;
    if (m0 !== 1 || m1 !== 1) {
      let g = m0;
      for (let i = 0; i < frames; i++) { L[i] *= g; if (R !== L) R[i] *= g; g += ms; }
    }
    this.masterC = m1;

    this.sinceReport += frames;
    if (this.sinceReport >= this.reportEvery) this.report(false);
    return true;
  }

  decayPeaks() {
    this.sinceReport += 128;
    if (this.sinceReport >= this.reportEvery && this.peaks.some((p) => p > 0.001)) {
      this.peaks = this.peaks.map((p) => p * 0.5);
      this.report(false);
    }
  }

  finish() {
    this.playing = false;
    this.shown = this.length;
    this.report(true);
    this.port.postMessage({ type: 'ended' });
    return true;
  }

  report(force) {
    this.sinceReport = 0;
    this.port.postMessage({ type: 'pos', time: Math.min(this.shown, this.length) / sampleRate,
                            peaks: this.peaks.slice(), playing: this.playing });
    this.peaks = this.peaks.map((p) => p * 0.6);
  }
}

registerProcessor('minusone-mixer', Mixer);
