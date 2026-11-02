/** Fixed-size stereo memory. No file access or per-block allocation on the audio thread. */
export class CaptureRing {
  constructor(rate) {
    this.rate = rate; this.capacity = Math.ceil(rate * 12);
    this.channels = [new Float32Array(this.capacity), new Float32Array(this.capacity)];
    this.enabled = true;
    this.reset();
  }
  reset() { this.first = null; this.end = 0; this.lastSound = -Infinity; }
  setEnabled(enabled) { this.enabled = !!enabled; this.reset(); }
  write(input, start, length) {
    if (!this.enabled) return;
    if (this.first === null) this.first = start;
    for (let i = 0; i < length; i++) {
      const at = (start + i) % this.capacity;
      for (let c = 0; c < 2; c++) {
        const value = input[c]?.[i] ?? input[0]?.[i] ?? 0;
        this.channels[c][at] = Number.isFinite(value) ? value : 0;
        if (Math.abs(value) > .00001) this.lastSound = start + i;
      }
    }
    this.end = start + length;
    this.first = Math.max(this.first, this.end - this.capacity);
  }
  snapshot(end = this.end, seconds = 10) {
    end = Math.min(this.end, Math.round(end));
    const start = Math.max(this.first ?? end, end - Math.round(this.rate * Math.min(10, seconds)));
    if (end <= start || this.lastSound < start) throw new Error('Play some audio first, then keep the moment you like.');
    const channels = this.channels.map(source => {
      const out = new Float32Array(end - start);
      for (let i = 0; i < out.length; i++) out[i] = source[(start + i) % this.capacity];
      return out;
    });
    if (!channels.some(c => c.some(v => Math.abs(v) > .00001))) throw new Error('There is no audible sound in these ten seconds yet.');
    return { channels, start, end, sampleRate: this.rate };
  }
}

if (typeof registerProcessor === 'function') registerProcessor('recent-audio', class extends AudioWorkletProcessor {
  constructor() {
    super(); this.ring = new CaptureRing(sampleRate); this.reportAt = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') this.ring.reset();
      if (data.type === 'enabled') this.ring.setEnabled(data.enabled);
      if (data.type === 'snapshot') {
        try { const result = this.ring.snapshot(data.end); this.port.postMessage({ id: data.id, ...result }, result.channels.map(c => c.buffer)); }
        catch (error) { this.port.postMessage({ id: data.id, error: error.message }); }
      }
    };
  }
  process(inputs, outputs) {
    this.ring.write(inputs[0] ?? [], currentFrame, outputs[0][0].length);
    if (currentFrame >= this.reportAt) {
      this.reportAt = currentFrame + sampleRate / 4;
      const audible = this.ring.lastSound >= this.ring.end - sampleRate * 10;
      this.port.postMessage({ type: 'status', seconds: audible ? Math.min(10, (this.ring.end - this.ring.first) / sampleRate) : 0 });
    }
    return true;
  }
});

