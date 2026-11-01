// MinusOne audio engine (main thread side).
// Decodes stems, hands them to the mixer worklet, and exposes simple transport controls.
import { SoundTouch } from './vendor/soundtouch.js';

const PEAK_BINS = 1800;

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.duration = 0;
    this.time = 0;
    this.playing = false;
    this.peaks = [];          // per stem Float32Array(PEAK_BINS)
    this.levels = [];
    this.blobs = [];
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule(new URL('./mixer-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'minusone-mixer', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.node.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') {
        this.time = m.time;
        this.levels = m.peaks;
        this.playing = m.playing;
        this.emit('time');
      } else if (m.type === 'ended') {
        this.playing = false;
        this.emit('ended');
      }
    };
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  // Messages sent before the worklet exists are dropped: load() passes the current gains anyway.
  post(m, transfer) { if (this.node) this.node.port.postMessage(m, transfer || []); }

  // stems: [{ name, blob }], gains: initial gain per stem
  async load(stems, gains, onProgress = () => {}) {
    await this.init();
    this.pause();
    this.post({ type: 'reset' });
    this.blobs = stems.map((s) => s.blob);
    this.peaks = [];
    this.duration = 0;
    this.time = 0;
    for (let i = 0; i < stems.length; i++) {
      onProgress(i / stems.length, stems[i].name);
      const buf = await this.ctx.decodeAudioData(await stems[i].blob.arrayBuffer());
      const L = buf.getChannelData(0);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      this.peaks[i] = peaksOf(L, R);
      const l16 = toInt16(L), r16 = R === L ? l16.slice() : toInt16(R);
      this.duration = Math.max(this.duration, buf.duration);
      this.post({ type: 'stem', index: i, left: l16, right: r16, gain: gains[i] }, [l16.buffer, r16.buffer]);
      await new Promise((r) => setTimeout(r, 0));
    }
    onProgress(1);
    this.emit('time');
  }

  async play() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.post({ type: 'play' });
    this.playing = true;
  }
  pause() { if (this.node) this.post({ type: 'pause' }); this.playing = false; }
  toggle() { return this.playing ? this.pause() : this.play(); }
  seek(t) {
    this.time = Math.max(0, Math.min(t, this.duration));
    this.post({ type: 'seek', time: this.time });
    this.emit('time');
  }
  setGains(gains) { this.post({ type: 'gains', gains }); }
  setMaster(v) { this.post({ type: 'master', value: v }); }
  setLoop(on, a, b) { this.post({ type: 'loop', on, a, b }); }
  setTempo(v) { this.post({ type: 'tempo', value: v }); }
  setPitch(semi) { this.post({ type: 'pitch', value: semi }); }

  // Render the current mix (gains, speed, key) to a 16-bit WAV blob.
  async renderMix({ gains, master = 1, tempo = 1, pitch = 0, from = 0, to = null }, onProgress = () => {}) {
    const rate = 44100;
    const off = new OfflineAudioContext(2, 1, rate);
    let length = 0;
    const chans = [];
    for (let i = 0; i < this.blobs.length; i++) {
      if (!gains[i]) { chans.push(null); continue; }
      const b = await off.decodeAudioData(await this.blobs[i].arrayBuffer());
      chans.push([b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)]);
      length = Math.max(length, b.length);
      onProgress(0.3 * (i + 1) / this.blobs.length);
    }
    if (!length) length = Math.round(this.duration * rate);
    const start = Math.round(from * rate);
    const end = Math.min(length, to == null ? length : Math.round(to * rate));
    const n = Math.max(0, end - start);
    const mixL = new Float32Array(n), mixR = new Float32Array(n);
    chans.forEach((c, i) => {
      if (!c) return;
      const g = gains[i] * master;
      for (let k = 0; k < n; k++) {
        const j = start + k;
        if (j < c[0].length) { mixL[k] += c[0][j] * g; mixR[k] += c[1][j] * g; }
      }
    });
    let outL = mixL, outR = mixR;
    if (tempo !== 1 || pitch !== 0) {
      const st = new SoundTouch();
      st.stretch.setParameters(rate, 0, 0, 8);
      st.tempo = tempo;
      st.pitchSemitones = pitch;
      const chunk = 8192, inter = new Float32Array(chunk * 2);
      const expected = Math.ceil(n / tempo) + rate;
      const resL = new Float32Array(expected), resR = new Float32Array(expected);
      let w = 0;
      const drain = () => {
        const ob = st.outputBuffer, avail = Math.min(ob.frameCount, expected - w);
        if (avail <= 0) return;
        const tmp = new Float32Array(avail * 2);
        ob.extract(tmp, 0, avail); ob.receive(avail);
        for (let i = 0; i < avail; i++) { resL[w + i] = tmp[i * 2]; resR[w + i] = tmp[i * 2 + 1]; }
        w += avail;
      };
      for (let p = 0; p < n + chunk * 2; p += chunk) {
        const take = Math.max(0, Math.min(chunk, n - p));
        for (let i = 0; i < chunk; i++) {
          inter[i * 2] = i < take ? mixL[p + i] : 0;
          inter[i * 2 + 1] = i < take ? mixR[p + i] : 0;
        }
        st.inputBuffer.putSamples(inter, 0, chunk);
        st.process();
        drain();
        if ((p / chunk) % 40 === 0) {
          onProgress(0.3 + 0.6 * Math.min(1, p / n));
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const keep = Math.min(w, Math.round(n / tempo));
      outL = resL.subarray(0, keep); outR = resR.subarray(0, keep);
    }
    onProgress(0.95);
    const blob = wavBlob(outL, outR, rate);
    onProgress(1);
    return blob;
  }
}

function toInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : v * 32767;
  }
  return out;
}

function peaksOf(L, R) {
  const bins = new Float32Array(PEAK_BINS);
  const size = L.length / PEAK_BINS;
  for (let b = 0; b < PEAK_BINS; b++) {
    const s = Math.floor(b * size), e = Math.min(L.length, Math.floor((b + 1) * size));
    let m = 0;
    for (let i = s; i < e; i += 4) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (v > m) m = v;
    }
    bins[b] = m;
  }
  return bins;
}

function wavBlob(L, R, rate) {
  const n = L.length, bytes = 44 + n * 4;
  const buf = new ArrayBuffer(bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 1 ? 1 / peak : 1;            // avoid clipping when stems sum above full scale
  const pcm = new Int16Array(buf, 44);
  for (let i = 0; i < n; i++) {
    pcm[i * 2] = Math.max(-1, Math.min(1, L[i] * k)) * 32767;
    pcm[i * 2 + 1] = Math.max(-1, Math.min(1, R[i] * k)) * 32767;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
