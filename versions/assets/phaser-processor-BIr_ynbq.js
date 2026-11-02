/* The same stateful DSP runs in the audio thread and in bounded export windows.
 * No allocation, messages or trigonometry per stage/sample in process(). */
export function normalizePhaser(raw = {}) {
  const n = (key, min, max, fallback) => Number.isFinite(raw[key]) ? Math.max(min, Math.min(max, raw[key])) : fallback;
  return { enabled: raw.enabled !== false, stages: [4, 6, 12].includes(raw.stages) ? raw.stages : 6,
    sync: raw.sync !== false, beats: n('beats', .25, 32, 4), hz: n('hz', .02, 8, .35),
    center: n('center', 150, 3200, 700), depth: n('depth', 0, 1, .65),
    feedback: n('feedback', -.8, .8, .35), mix: n('mix', 0, 1, .5),
    stereo: n('stereo', 0, 1, .35), bass: n('bass', 0, 300, 120) };
}
export class PhaserDSP {
  constructor(rate, settings = {}, bpm = 140, offset = 0) {
    this.rate = rate; this.clock = Math.round(offset * rate); this.coefficientsReady = false; this.settings = normalizePhaser(settings); this.bpm = bpm;
    this.smooth = { ...this.settings, speed: this.speed(), mix: this.settings.enabled ? this.settings.mix : 0 };
    this.phase = ((offset * this.smooth.speed) % 1 + 1) % 1;
    this.z = [new Float64Array(12), new Float64Array(12)]; this.coefficients = [new Float64Array(12), new Float64Array(12)];
    this.coefficientSteps = [new Float64Array(12), new Float64Array(12)]; this.bassStep = 0;
    this.low = [0, 0]; this.feedback = [0, 0]; this.slew = 1 - Math.exp(-1 / (.02 * rate)); this.bassPole = 1;
  }
  speed() { return this.settings.sync ? Math.max(20, Math.min(400, this.bpm)) / 60 / this.settings.beats : this.settings.hz; }
  set(settings, bpm = this.bpm) { this.settings = normalizePhaser(settings); this.bpm = bpm; this.coefficientsReady = false; }
  process(left, right, outLeft, outRight, from = 0, count = outLeft.length - from) {
    const s = this.smooth, target = this.settings, speed = this.speed(), mix = target.enabled ? target.mix : 0;
    for (let i = from; i < from + count; i++) {
      s.speed += this.slew * (speed - s.speed); s.mix += this.slew * (mix - s.mix);
      s.center += this.slew * (target.center - s.center); s.depth += this.slew * (target.depth - s.depth);
      s.feedback += this.slew * (target.feedback - s.feedback); s.stereo += this.slew * (target.stereo - s.stereo);
      s.bass += this.slew * (target.bass - s.bass); s.stages += this.slew * (target.stages - s.stages);
      if (!this.coefficientsReady || this.clock % 16 === 0) {
        this.coefficientsReady = true;
        // Predict the next control point, then interpolate allpass coefficients
        // per sample. Holding them for 16 samples adds staircase modulation and
        // a sweep lag, especially with fast, deep, high-feedback settings.
        // The exponential smoother has a closed-form future state, including
        // the speed integral. No extra trigonometry is needed between points.
        const steps = 16 - ((this.clock % 16 + 16) % 16), decay = Math.pow(1 - this.slew, steps);
        const futureCenter = target.center + (s.center - target.center) * decay;
        const futureDepth = target.depth + (s.depth - target.depth) * decay;
        const futureStereo = target.stereo + (s.stereo - target.stereo) * decay;
        const futurePhase = this.phase + (steps * speed + (s.speed - speed) * (1 - decay) / this.slew) / this.rate;
        this.bassPole = Math.exp(-2 * Math.PI * s.bass / this.rate);
        this.bassStep = (Math.exp(-2 * Math.PI * (target.bass + (s.bass - target.bass) * decay) / this.rate) - this.bassPole) / steps;
        for (let c = 0; c < 2; c++) {
          const sweep = s.center * Math.pow(2, 3.2 * s.depth * Math.sin(2 * Math.PI * (this.phase + (c ? s.stereo * .5 : 0))));
          const futureSweep = futureCenter * Math.pow(2, 3.2 * futureDepth * Math.sin(2 * Math.PI * (futurePhase + (c ? futureStereo * .5 : 0))));
          for (let stage = 0; stage < 6; stage++) {
            const t = Math.tan(Math.PI * Math.min(this.rate * .42, Math.max(25, sweep * (.82 + (stage % 6) * .072))) / this.rate);
            const next = Math.tan(Math.PI * Math.min(this.rate * .42, Math.max(25, futureSweep * (.82 + stage * .072))) / this.rate);
            const coefficient = (1 - t) / (1 + t), increment = ((1 - next) / (1 + next) - coefficient) / steps;
            this.coefficients[c][stage] = this.coefficients[c][stage + 6] = coefficient;
            this.coefficientSteps[c][stage] = this.coefficientSteps[c][stage + 6] = increment;
          }
        }
      }
      for (let c = 0; c < 2; c++) {
        const input = (c ? right : left)[i] || 0;
        this.low[c] = input + this.bassPole * (this.low[c] - input);
        const dry = input - this.low[c];
        let wet = dry * (1 - Math.abs(s.feedback) * .55) + this.feedback[c] * s.feedback, four = 0, six = 0;
        const z = this.z[c], a = this.coefficients[c];
        for (let stage = 0; stage < 12; stage++) {
          const y = -a[stage] * wet + z[stage]; z[stage] = wet + a[stage] * y; wet = y;
          a[stage] += this.coefficientSteps[c][stage];
          if (stage === 3) four = wet; if (stage === 5) six = wet;
        }
        wet = s.stages < 6 ? four + (six - four) * (s.stages - 4) / 2 : six + (wet - six) * (s.stages - 6) / 6;
        this.feedback[c] = wet;
        (c ? outRight : outLeft)[i] = this.low[c] + dry * (1 - s.mix) + wet * s.mix;
      }
      this.bassPole += this.bassStep;
      this.phase = (this.phase + s.speed / this.rate) % 1; this.clock++;
    }
  }
}
if (typeof registerProcessor === 'function') {
  class PhaserProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super(); const o = options.processorOptions;
      this.dsp = new PhaserDSP(sampleRate, o.settings, o.bpm, o.offset); this.startTime = Infinity;
      this.port.onmessage = ({ data }) => { if (data.type === 'arm') this.startTime = data.time; else this.dsp.set(data.settings, data.bpm); };
    }
    process(inputs, outputs) {
      const input = inputs[0], output = outputs[0];
      if (!input?.[0] || !output?.[0]) return true;
      const from = Math.max(0, Math.min(output[0].length, Math.ceil((this.startTime - currentTime) * sampleRate)));
      this.dsp.process(input[0], input[1] || input[0], output[0], output[1], from, output[0].length - from);
      return true;
    }
  }
  registerProcessor('music-phaser', PhaserProcessor);
}
