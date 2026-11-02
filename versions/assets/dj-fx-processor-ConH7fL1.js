/* Original tempo effects. Fixed storage; one stereo timing path; no timers. */
const VERB_TAPS = [.0297, .0371, .0411, .0437, .0719, .1093];
const REVERSE_TAPS = [.17, .29, .43, .61, .79, .97];
const BREAK_DIVISIONS = [1, 2, 1, 4, 2, 8, 4, 2];
export class DjFxDSP {
  constructor(rate) {
    // Two guard frames leave room for interpolation at an exact 8-second tap.
    this.rate = rate; this.size = Math.ceil(rate * 8) + 2; this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.at = 0; this.clock = 0; this.started = 0; this.effect = 'off'; this.wet = 0; this.targetWet = 0;
    this.beats = 1; this.bpm = 120; this.amount = .5; this.low = [0, 0]; this.feedback = [0, 0];
    this.phaser = [new Float64Array(6), new Float64Array(6)]; this.hold = [0, 0]; this.seed = 701;
    this.freezeAt = 0; this.freezeLength = 1; this.freezeReady = false;
  }
  reset() {
    this.ring[0].fill(0); this.ring[1].fill(0); this.low[0] = this.low[1] = this.feedback[0] = this.feedback[1] = 0;
    this.phaser[0].fill(0); this.phaser[1].fill(0); this.hold[0] = this.hold[1] = 0;
    this.started = this.clock; this.freezeAt = this.at; this.freezeReady = false;
  }
  set(m) {
    if (m.effect !== this.effect || (this.targetWet === 0 && m.wet > 0)) { this.started = this.clock; this.freezeAt = this.at; this.freezeReady = false; this.feedback[0] = this.feedback[1] = 0; }
    this.effect = m.effect; this.targetWet = Math.max(0, Math.min(1, m.wet)); this.beats = Math.max(1 / 32, Math.min(64, m.beats));
    this.bpm = Math.max(20, Math.min(400, m.bpm)); this.amount = Math.max(0, Math.min(1, m.amount ?? .5));
    this.freezeLength = Math.max(1, Math.min(Math.round(this.rate * 4), Math.round(this.rate * 60 / this.bpm * this.beats)));
  }
  tap(channel, delay) {
    const position = (this.at - Math.max(1, Math.min(this.size - 2, delay)) + this.size) % this.size, a = Math.floor(position), f = position - a;
    return this.ring[channel][a] * (1 - f) + this.ring[channel][(a + 1) % this.size] * f;
  }
  freeze(channel, backwards = false, divisions = 1) {
    const length = Math.max(1, Math.round(this.freezeLength / divisions));
    const elapsed = this.clock - this.started;
    if (elapsed < this.freezeLength) return this.tap(channel, 1);
    const phase = elapsed % length;
    const index = (this.freezeAt + (backwards ? length - 1 - phase : phase) + this.size) % this.size;
    return this.ring[channel][index];
  }
  pitch(channel, ratio) {
    // Complementary moving delay heads: continuous pitch shift without source seeks.
    const span = this.rate * .06, phase = ((this.clock - this.started) * Math.abs(1 - ratio) / span) % 1;
    const a = phase, b = (phase + .5) % 1;
    const wa = .5 - .5 * Math.cos(2 * Math.PI * a), wb = 1 - wa;
    return this.tap(channel, 1 + (ratio < 1 ? a : 1 - a) * span) * wa + this.tap(channel, 1 + (ratio < 1 ? b : 1 - b) * span) * wb;
  }
  process(input, output) {
    const length = output[0]?.length ?? 0;
    for (let i = 0; i < length; i++, this.clock++) {
      const elapsed = this.clock - this.started, beat = this.rate * 60 / this.bpm, period = Math.max(1, beat * this.beats), phase = elapsed % period / period;
      const lfo = .5 - .5 * Math.cos(phase * Math.PI * 2), progress = Math.min(1, elapsed / Math.max(1, period * 4));
      const delay = Math.max(1, Math.min(this.size - 2, period));
      const type = this.effect, enabled = type !== 'off'; this.wet += ((enabled ? this.targetWet : 0) - this.wet) * .006;
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0; const noise = (this.seed / 4294967296 * 2 - 1) * .2;
      for (let c = 0; c < output.length; c++) {
        const dry = input[c]?.[i] ?? input[0]?.[i] ?? 0; let value = dry, feedback = 0, cutoff = 0, highpass = false;
        const echo = this.tap(c, delay), short = this.tap(c, this.rate * (.001 + .006 * lfo * (.4 + 1.2 * this.amount)));
        if (type === 'echo' || type === 'echo-out' || type === 'delay' || type === 'hold-echo' || type === 'ping-pong' || type === 'sweep-echo' || type === 'touch-lfo-echo' || type === 'touch-filter-echo' || type === 'touch-filter-dub') {
          const repeated = type === 'ping-pong' ? this.tap(1 - c, delay) : echo;
          const decay = type === 'delay' ? 0 : type === 'hold-echo' ? .9 + this.amount * .099 : type === 'touch-filter-dub' ? .82 : type === 'touch-lfo-echo' ? .2 + this.amount * .6 : .15 + this.amount * .66;
          value = repeated * (type === 'echo-out' ? 1 - progress : 1);
          feedback = repeated * decay;
          if (type === 'delay') cutoff = 400 * Math.pow(40, this.amount);
          if (type === 'touch-lfo-echo') value *= lfo;
          if (type.startsWith('touch-filter')) cutoff = 180 * Math.pow(80, this.amount);
          if (type === 'sweep-echo') cutoff = 160 * Math.pow(90, 1 - this.amount);
        } else if (type === 'roll' || type === 'stutter-out' || type === 'recycler' || type === 'beat-break' || type === 'touch-filter-roll') {
          const divisions = type === 'stutter-out' ? Math.pow(2, Math.min(4, Math.floor(progress * 5))) : type === 'beat-break' ? BREAK_DIVISIONS[Math.floor(elapsed / beat) % 8] : type === 'recycler' ? 2 : 1;
          value = this.freeze(c, type === 'recycler' && Math.floor(elapsed / beat) % 2 === 1, divisions);
          // Character controls the space between frozen hits, independently of
          // beat length. Short ramps suppress repeat-boundary clicks.
          const loopLength = Math.max(1, Math.round(this.freezeLength / divisions));
          const rollPhase = elapsed % loopLength, open = loopLength * (type === 'touch-filter-roll' ? 1 : 1 - this.amount * .8);
          const edge = Math.max(1, Math.min(this.rate * .002, open / 4));
          if (elapsed >= this.freezeLength) value *= Math.max(0, Math.min(1, rollPhase / edge, (open - rollPhase) / edge));
          if (type === 'stutter-out') value *= 1 - progress;
          if (type === 'touch-filter-roll') cutoff = 180 * Math.pow(80, this.amount);
        } else if (type.includes('verb') || type === 'sweep-wash') {
          const taps = type === 'reverse-verb' ? REVERSE_TAPS : VERB_TAPS;
          value = 0;
          for (let n = 0; n < taps.length; n++) value += this.tap((c + n) % 2, this.rate * taps[n] * (1 + this.amount)) * (type === 'reverse-verb' ? (n + 1) / 21 : (6 - n) / 21);
          feedback = value * .64;
          if (type === 'swell-verb') value *= Math.min(1, elapsed / Math.max(1, period));
          if (type === 'lfo-verb') value *= lfo;
          if (type === 'reverb-drop') { value *= 1 - progress; cutoff = 180 * Math.pow(80, 1 - progress); }
          if (type === 'reverb-rise') { value *= progress; cutoff = 180 * Math.pow(80, progress); }
          if (type === 'touch-filter-reverb' || type === 'sweep-wash') cutoff = 180 * Math.pow(80, this.amount);
        } else if (type === 'flanger' || type === 'negative-flanger' || type === 'touch-flanger') {
          value = (dry + short * (type === 'negative-flanger' ? -.8 : .8)) / 1.8; feedback = short * .25;
        } else if (type === 'phaser') {
          const coefficient = .15 + .7 * (.5 + (lfo - .5) * (.25 + this.amount * .75)); value = dry * (1 - this.amount * .4) + this.feedback[c] * this.amount * .65;
          for (let n = 0; n < 6; n++) { const old = this.phaser[c][n], next = -coefficient * value + old; this.phaser[c][n] = value + coefficient * next; value = next; }
          this.feedback[c] = value; value = (dry + value) * .5;
        } else if (type === 'flex-gate' || type === 'touch-filter-gate' || type === 'touch-noise-gate') {
          const duty = type === 'flex-gate' ? .95 - this.amount * .8 : .65;
          const articulation = Math.max(0, Math.min(1, phase / .012, (duty - phase) / .012));
          value = (type === 'touch-noise-gate' ? noise : dry) * articulation;
          if (type === 'touch-filter-gate') cutoff = 180 * Math.pow(80, this.amount);
          if (type === 'touch-noise-gate') cutoff = 100 * Math.pow(120, this.amount);
        } else if (type === 'sweep-filter') {
          highpass = this.amount > .5;
          cutoff = highpass ? 20 * Math.pow(600, (this.amount - .5) * 2) : this.rate * .45 * Math.pow(180 / (this.rate * .45), (.5 - this.amount) * 2);
        } else if (type === 'lfo-filter' || type === 'touch-lfo-filter' || type === 'touch-filter') {
          cutoff = 80 * Math.pow(200, type.includes('lfo') ? lfo * (.15 + .85 * this.amount) : this.amount);
        } else if (type === 'riser') { value = this.pitch(c, Math.pow(2, (3 + 21 * this.amount) * progress / 12)); cutoff = 180 * Math.pow(80, progress); }
        else if (type === 'pitch-down' || type === 'scale-down') { const ratio = type === 'scale-down' ? Math.pow(2, -Math.floor(progress * (3 + 21 * this.amount)) / 12) : Math.pow(2, -progress * (2 + 22 * this.amount) / 12); value = this.pitch(c, ratio); }
        // Reverse-moving, crossfaded read heads work even when the effect was
        // just enabled. A continually increasing backward seek read only empty
        // pre-start history in a newly created worklet (the old silent wet path).
        else if (type === 'backspin') value = this.pitch(c, -(.5 + this.amount * 3.5) * (1 - progress)) * (1 - progress);
        else if (type === 'brake') value = this.tap(c, 1 + elapsed * progress * (.15 + this.amount * .7)) * (1 - progress);
        else if (type === 'crush') { if (this.clock % (2 + Math.round(this.amount * 18)) === 0) this.hold[c] = Math.round(dry * (256 - this.amount * 240)) / (256 - this.amount * 240); value = this.hold[c]; }
        else if (type === 'sweep-noise') { value = noise; cutoff = 120 * Math.pow(120, this.amount); }
        if (cutoff) { const coefficient = 1 - Math.exp(-Math.PI * 2 * Math.min(this.rate * .45, cutoff) / this.rate); this.low[c] += coefficient * (value - this.low[c]); value = highpass ? value - this.low[c] : this.low[c]; }
        const frozen = (type === 'roll' || type === 'stutter-out' || type === 'recycler' || type === 'beat-break' || type === 'touch-filter-roll') && elapsed >= this.freezeLength;
        if (!frozen) this.ring[c][this.at] = Math.max(-4, Math.min(4, (type === 'hold-echo' && elapsed >= delay ? 0 : dry) + feedback));
        const sample = dry * (1 - this.wet) + value * this.wet;
        output[c][i] = Number.isFinite(sample) ? sample : 0;
      }
      this.at = (this.at + 1) % this.size;
    }
  }
}
if (typeof registerProcessor === 'function') registerProcessor('dj-performance-fx', class extends AudioWorkletProcessor {
  constructor() { super(); this.dsp = new DjFxDSP(sampleRate); this.port.onmessage = event => event.data.type === 'reset' ? this.dsp.reset() : this.dsp.set(event.data); }
  process(inputs, outputs) { this.dsp.process(inputs[0] ?? [], outputs[0]); return true; }
});

