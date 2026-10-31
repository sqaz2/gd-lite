/** Fixed pool: a slow writer stops capture rather than growing memory or dropping samples. */
export class MicPageCapture {
  constructor(rate, send, pageFrames = 16384, poolSize = 6, maxFrames = Math.floor((1500000000 - 44) / 2), channels = 1) {
    this.rate = rate; this.send = send; this.pageFrames = pageFrames; this.channels = channels === 2 ? 2 : 1;
    this.maxFrames = Math.min(maxFrames, Math.floor((1500000000 - 44) / (2 * this.channels)));
    this.pool = Array.from({ length: poolSize }, () => new ArrayBuffer(pageFrames * 2 * this.channels));
    this.buffer = null; this.view = null; this.active = false; this.reportAt = 0; this.meterPeak = 0;
    this.token = 0; this.index = 0; this.used = 0; this.frames = 0; this.first = null;
    this.monoChannel = undefined;
  }
  recycle(buffer) { if (buffer instanceof ArrayBuffer && buffer.byteLength === this.pageFrames * 2 * this.channels) this.pool.push(buffer); }
  start(at, token) {
    if (this.active) this.stop('A second recording was requested before the first one finished.');
    this.at = at; this.token = token; this.active = true; this.first = null; this.frames = 0; this.index = 0; this.used = 0;
  }
  flush() {
    if (!this.buffer || !this.used) return;
    const buffer = this.buffer, frames = this.used;
    this.buffer = null; this.view = null; this.used = 0;
    this.send({ type: 'page', token: this.token, index: this.index++, startContextFrame: this.first + this.frames - frames, frames, buffer }, [buffer]);
  }
  stop(reason) {
    if (!this.active) return;
    this.active = false; this.flush();
    this.send({ type: 'stopped', token: this.token, startContextFrame: this.first, frames: this.frames, reason });
  }
  process(input, startFrame, length, output) {
    // The legacy single-array call stays supported. The worklet supplies planar inputs.
    const planar = Array.isArray(input) && (input.length === 0 || typeof input[0] !== 'number');
    // Keep a real microphone channel when a USB/headset adapter supplies an
    // empty partner or a reversed-polarity copy. Normal stereo sums still mix.
    if (this.monoChannel === undefined && planar && this.channels === 1 && input.length > 1) {
      let strongest = 0, strongestPower = 0, mixedPower = 0;
      for (let c = 0; c < input.length; c++) {
        let power = 0;
        for (let i = 0; i < length; i++) { const v = input[c]?.[i]; if (Number.isFinite(v)) power += v * v; }
        if (power > strongestPower) { strongestPower = power; strongest = c; }
      }
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) if (Number.isFinite(input[c]?.[i])) sum += input[c][i];
        mixedPower += (sum / input.length) ** 2;
      }
      // Keep the decision for this open input: changing channels on each block
      // would introduce discontinuities. Reopening the input starts a new check.
      if (strongestPower > 0) this.monoChannel = mixedPower <= strongestPower * .26 ? strongest : -1;
    }
    for (let i = 0; i < length; i++) {
      let left = 0, right = 0;
      if (planar && this.channels === 1) {
        if (this.monoChannel >= 0) left = input[this.monoChannel]?.[i] ?? 0;
        else for (let c = 0; c < input.length; c++) left += Number.isFinite(input[c]?.[i]) ? input[c][i] / input.length : 0;
      } else {
        left = (planar ? input[0]?.[i] : input?.[i]) ?? 0;
        right = (planar ? input[1]?.[i] : undefined) ?? left;
      }
      left = Number.isFinite(left) ? Math.max(-1, Math.min(1, left)) : 0;
      right = Number.isFinite(right) ? Math.max(-1, Math.min(1, right)) : 0;
      // Monitoring uses the exact same channel decision as the saved take. Its
      // separate gain remains zero until the user enables Hear my voice.
      if (output?.[0]) output[0][i] = left;
      if (output?.[1]) output[1][i] = right;
      this.meterPeak = Math.max(this.meterPeak, Math.abs(left), this.channels === 2 ? Math.abs(right) : 0);
      if (!this.active || startFrame + i < this.at) continue;
      if (!this.buffer) {
        const buffer = this.pool.pop();
        if (!buffer) { this.stop('Device storage could not keep up with the microphone. The saved portion has been kept.'); continue; }
        this.buffer = buffer; this.view = new DataView(buffer);
      }
      if (this.first === null) {
        this.first = startFrame + i;
        this.send({ type: 'started', token: this.token, startContextFrame: this.first });
      }
      const offset = this.used * this.channels * 2;
      this.view.setInt16(offset, Math.round(left * (left < 0 ? 32768 : 32767)), true);
      if (this.channels === 2) this.view.setInt16(offset + 2, Math.round(right * (right < 0 ? 32768 : 32767)), true);
      this.used++; this.frames++;
      if (this.used === this.pageFrames) this.flush();
      if (this.frames >= this.maxFrames) this.stop('This take reached the supported recording file size. The saved portion has been kept.');
    }
    if (startFrame >= this.reportAt) {
      this.reportAt = startFrame + this.rate / 10;
      this.send({ type: 'level', peak: this.meterPeak }); this.meterPeak = 0;
    }
  }
}

if (typeof registerProcessor === 'function') registerProcessor('microphone-take', class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions ?? {};
    this.capture = new MicPageCapture(sampleRate, (message, transfer = []) => this.port.postMessage(message, transfer), config.pageFrames, config.poolSize, config.maxFrames, config.channels);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') this.capture.start(data.atContextFrame, data.token);
      if (data.type === 'stop') this.capture.stop(data.reason);
      if (data.type === 'recycle') this.capture.recycle(data.buffer);
    };
  }
  process(inputs, outputs) {
    this.capture.process(inputs[0] ?? [], currentFrame, outputs[0]?.[0]?.length ?? 128, outputs[0]);
    return true;
  }
});
