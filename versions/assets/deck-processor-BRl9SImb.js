/* Source-audio transport. PCM arrives in small pages; the audio thread owns time. */
const kernelCache = new Map();
/** Prepared before connecting the worklet. Tables keep trigonometry/allocation off its render path. */
export function createDeckKernels(sourceRate, outputRate) {
  if (!Number.isFinite(sourceRate) || !Number.isFinite(outputRate) || sourceRate < 8000 || sourceRate > 192000 || outputRate < 8000 || outputRate > 192000) throw new Error("The live deck supports sample rates from 8 to 192 kHz.");
  if (sourceRate / outputRate > 4) throw new Error("This source rate is too high for the current audio output. The live deck supports a source rate up to four times the output rate; use a higher-rate output or a lower-rate copy.");
  const maxStep = Math.max(4, 4 * sourceRate / outputRate), key = String(maxStep);
  if (kernelCache.has(key)) return kernelCache.get(key);
  const phases = 64, banks = Math.ceil(32 * Math.log(maxStep) / Math.log(4)), logStep = Math.log(maxStep);
  const bankTaps = new Uint16Array(banks + 1), bankOffsets = new Uint32Array(banks + 1);
  let count = 0;
  for (let bank = 0; bank <= banks; bank++) {
    bankTaps[bank] = Math.ceil(64 * Math.exp(bank / banks * logStep) / 8) * 8;
    bankOffsets[bank] = count; count += (phases + 1) * bankTaps[bank];
  }
  const taps = bankTaps[banks], weights = new Float32Array(count);
  for (let bank = 0; bank <= banks; bank++) {
    // Grow support with decimation so the transition remains below Nyquist.
    // Bank spacing is bounded even for different source/output sample rates.
    const support = bankTaps[bank], cutoff = .42 / Math.exp(bank / banks * logStep);
    for (let phase = 0; phase <= phases; phase++) {
      const base = bankOffsets[bank] + phase * support;
      let sum = 0;
      for (let tap = 0; tap < support; tap++) {
        const distance = tap - (support / 2 - 1) - phase / phases;
        const window = Math.abs(distance) >= support / 2 ? 0 : .42 + .5 * Math.cos(Math.PI * distance / (support / 2)) + .08 * Math.cos(2 * Math.PI * distance / (support / 2));
        const angle = 2 * Math.PI * cutoff * distance;
        const value = 2 * cutoff * (Math.abs(angle) < 1e-12 ? 1 : Math.sin(angle) / angle) * window;
        weights[base + tap] = value; sum += value;
      }
      for (let tap = 0; tap < support; tap++) weights[base + tap] /= sum;
    }
  }
  const result = { maxStep, taps, phases, banks, logStep, bankTaps, bankOffsets, weights };
  // One table per active sample-rate pairing; don't retain arbitrary old projects.
  let retainedBytes = weights.byteLength;
  for (const table of kernelCache.values()) retainedBytes += table.weights.byteLength;
  while (kernelCache.size && (kernelCache.size >= 4 || retainedBytes > 12 * 1024 * 1024)) {
    const oldest = kernelCache.keys().next().value; retainedBytes -= kernelCache.get(oldest).weights.byteLength; kernelCache.delete(oldest);
  }
  kernelCache.set(key, result); return result;
}
export class DeckDSP {
  constructor(rate, send = () => {}, kernels = createDeckKernels(rate, rate)) {
    this.rate = rate; this.send = send; this.pages = new Map(); this.pageFrames = rate * 4;
    this.kernels = kernels; this.readLeft = 0; this.readRight = 0;
    this.previousPages = new Map();
    this.total = 1; this.position = 0; this.shadow = 0; this.clock = 0; this.startClock = 0;
    this.startAtFrame = null;
    this.running = false; this.speed = 1; this.targetSpeed = 1; this.scratchSpeed = null;
    this.bpm = 140; this.beatFrame = 0; this.loop = null; this.pending = null;
    this.tempoMap = []; this.tempoIndex = -1; this.baseBpm = 140; this.baseBeatFrame = 0;
    this.effect = "clean"; this.effectBeats = .5; this.gain = 0; this.last = [0, 0];
    this.crossfade = 0; this.old = [0, 0]; this.low = [0, 0];
    this.delay = [new Float32Array(rate * 6), new Float32Array(rate * 6)]; this.delayAt = 0;
    this.ended = false; this.missing = -1; this.reportAt = 0; this.scratchAt = 0;
    // Fixed-memory WSOLA: both channels share each grain's source location.
    // PCM pages remain the only long-lived source cache; no song-sized buffer.
    this.keyLock = false; this.stretchActive = false; this.stretchAt = 0;
    this.grainFrames = Math.max(256, Math.round(rate * .04 / 2) * 2); this.grainHop = this.grainFrames / 2;
    this.grainWindow = Float32Array.from({ length: this.grainFrames }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * (i + .5) / this.grainFrames));
    this.stretchPCM = [new Float32Array(this.grainFrames * 2), new Float32Array(this.grainFrames * 2)];
    this.stretchWeight = new Float32Array(this.grainFrames * 2);
    this.grainPCM = [new Float32Array(this.grainFrames), new Float32Array(this.grainFrames)];
    // A bounded contiguous halo keeps per-tap source-page lookups out of the
    // resampling inner loop when project and hardware sample rates differ.
    this.grainSource = [new Float32Array(this.grainFrames * 4 + 2048), new Float32Array(this.grainFrames * 4 + 2048)];
    this.correlationTail = [new Float64Array(64), new Float64Array(64)]; this.correlationOffsets = new Int32Array(64);
  }
  message(m) {
    if (m.type === "page") { const old = this.pages.get(m.index); if (old) this.previousPages.set(m.index, { channels: old, until: this.clock + Math.round(this.rate * .012) }); this.pages.set(m.index, m.channels); this.missing = -1; return; }
    if (m.type === "retain") { const keep = new Set(m.indices); for (const key of this.pages.keys()) if (!keep.has(key)) { this.pages.delete(key); this.previousPages.delete(key); } return; }
    if (m.type === "length") { this.total = m.total; return; }
    if (m.type === "init") { this.total = m.total; this.pageFrames = m.pageFrames; this.sourceRate = m.sourceRate; this.position = m.start; this.shadow = m.start;
      if (this.kernels.maxStep !== Math.max(4, 4 * m.sourceRate / this.rate)) this.kernels = createDeckKernels(m.sourceRate, this.rate);
      return; }
    if (m.type === "play") { this.running = m.playing; this.ended = false; this.startClock = m.delayFrames ? this.clock + m.delayFrames : this.clock; this.startAtFrame = Number.isFinite(m.atFrame) ? Math.round(m.atFrame) : null; return; }
    if (m.type === "tempo") { this.baseBpm = this.bpm = m.bpm; this.baseBeatFrame = this.beatFrame = m.beatFrame; this.tempoMap = []; this.tempoIndex = -1; return; }
    if (m.type === 'tempoMap') {
      this.baseBpm = Number.isFinite(m.bpm) ? Math.max(20, Math.min(400, m.bpm)) : this.baseBpm;
      this.baseBeatFrame = Number.isFinite(m.beatFrame) ? m.beatFrame : 0;
      this.tempoMap = Array.isArray(m.anchors) ? m.anchors.filter(a => Number.isFinite(a.startFrame) && a.startFrame >= 0 && Number.isFinite(a.beatFrame) && Number.isFinite(a.bpm) && a.bpm >= 20 && a.bpm <= 400).sort((a, b) => a.startFrame - b.startFrame).slice(0, 24) : [];
      this.bpm = this.baseBpm; this.beatFrame = this.baseBeatFrame;
      this.tempoIndex = -2; this.updateTempo(this.position); return;
    }
    if (m.type === "speed") { this.targetSpeed = Math.max(.25, Math.min(4, m.value)); return; }
    if (m.type === "keyLock") { this.keyLock = !!m.value; this.resetStretch(); return; }
    if (m.type === "scratch") { this.scratchSpeed = Math.max(-4, Math.min(4, m.value)); this.scratchAt = this.clock; return; }
    if (m.type === "release") {
      const held = this.scratchSpeed !== null; this.scratchSpeed = null;
      if (m.slip && held) {
        let target = this.shadow;
        if (this.loop) { const length = this.loop.end - this.loop.start; target = this.loop.start + ((target - this.loop.start) % length + length) % length; }
        this.jump(target); this.speed = this.targetSpeed;
      }
      return;
    }
    if (m.type === 'cancelQueue') { this.pending = null; return; }
    if (m.type === "queue") {
      const division = typeof m.quantize === "number" && Number.isFinite(m.quantize) ? Math.max(1 / 32, Math.min(64, m.quantize)) : 1;
      const next = this.nextGrid(this.position + (this.sourceRate || this.rate) * .025, division);
      const wait = Number.isFinite(m.delayFrames) ? Math.max(0, m.delayFrames) : m.quantize === false || !this.running ? 0 : Math.max(0, (next - this.position) / Math.max(.25, this.targetSpeed) / (this.sourceRate || this.rate) * this.rate);
      this.pending = { ...m.command, clock: this.clock + Math.round(wait), atFrame: Number.isFinite(m.atFrame) ? Math.round(m.atFrame) : null, beatPosition: m.quantize === false || !this.running ? this.position : next, retryFrames: Math.max(1, Math.round(this.rate * 60 / this.bpm * division / this.targetSpeed)) };
      return;
    }
  }
  tempoAt(position) {
    for (let i = this.tempoMap.length - 1; i >= 0; i--) if (position >= this.tempoMap[i].startFrame) return this.tempoMap[i];
    return null;
  }
  updateTempo(position) {
    if (!this.tempoMap.length) return;
    let index = this.tempoIndex;
    if (index === -2 || (index >= 0 && position < this.tempoMap[index].startFrame) || (index + 1 < this.tempoMap.length && position >= this.tempoMap[index + 1].startFrame)) {
      index = this.tempoMap.length - 1;
      while (index >= 0 && position < this.tempoMap[index].startFrame) index--;
      this.tempoIndex = index; this.bpm = index >= 0 ? this.tempoMap[index].bpm : this.baseBpm; this.beatFrame = index >= 0 ? this.tempoMap[index].beatFrame : this.baseBeatFrame;
    }
  }
  nextGrid(position, division) {
    let anchor = this.tempoAt(position), bpm = anchor?.bpm ?? this.baseBpm, origin = anchor?.beatFrame ?? this.baseBeatFrame;
    const sourceRate = this.sourceRate || this.rate;
    let beat = sourceRate * 60 / bpm * division, next = origin + Math.ceil((position - origin) / beat) * beat;
    // A future grid edit owns its first beat; don't queue against an obsolete
    // tempo when a boundary falls between the current cursor and the next beat.
    for (const point of this.tempoMap) if (point.startFrame > position && point.startFrame <= next) {
      bpm = point.bpm; origin = point.beatFrame; beat = sourceRate * 60 / bpm * division;
      next = origin + Math.ceil((point.startFrame - origin) / beat) * beat;
    }
    return next;
  }
  beatAdvance(position, beats) {
    let cursor = position, remaining = beats;
    const sourceRate = this.sourceRate || this.rate;
    let bpm = this.tempoAt(cursor)?.bpm ?? this.baseBpm;
    for (const point of this.tempoMap) {
      if (point.startFrame <= cursor) continue;
      const toBoundary = (point.startFrame - cursor) / (sourceRate * 60 / bpm);
      if (remaining <= toBoundary) return cursor + remaining * sourceRate * 60 / bpm;
      remaining -= toBoundary; cursor = point.startFrame; bpm = point.bpm;
    }
    return cursor + remaining * sourceRate * 60 / bpm;
  }
  jump(position, keepStretch = false) {
    if (!keepStretch) { this.old = [...this.last]; this.crossfade = Math.round(this.rate * .005); }
    this.position = Math.max(0, Math.min(this.total - 1, position)); this.ended = false;
    this.updateTempo(this.position);
    if (!keepStretch) this.resetStretch();
  }
  loopRange(m) {
    const wanted = m.start ?? this.loop?.start ?? m.beatPosition;
    const length = m.end !== undefined ? m.end - (m.start ?? 0) : this.beatAdvance(wanted, m.beats) - wanted;
    const start = Math.max(0, Math.min(this.total - Math.min(this.total, length), m.start ?? this.loop?.start ?? m.beatPosition));
    return { start, end: Math.min(this.total, start + length), beats: m.beats };
  }
  apply(m) {
    if (m.action === "seek") { this.jump(m.frame); this.shadow = this.position; this.loop = null; if (Number.isFinite(m.speed)) this.speed = this.targetSpeed = Math.max(.25, Math.min(4, m.speed)); }
    if (m.action === "loop") {
      const loop = this.loopRange(m);
      if (loop.end > loop.start) { this.loop = loop; this.jump(loop.start); }
    }
    if (m.action === "unloop") { const end = this.loop?.end; this.loop = null; if (m.slip) this.jump(this.shadow); else if (end !== undefined) this.jump(end); }
    if (m.action === "effect") { this.effect = m.effect; this.effectBeats = m.beats ?? .5; }
  }
  resetStretch() {
    this.stretchAt = 0; this.stretchActive = false;
    this.stretchWeight.fill(0); this.stretchPCM[0].fill(0); this.stretchPCM[1].fill(0);
  }
  /** Pitch-preserving grains use a linked stereo waveform-similarity search. */
  readStretched(position) {
    const size = this.stretchWeight.length, at = this.stretchAt % size, ratio = (this.sourceRate || this.rate) / this.rate;
    if (this.stretchAt % this.grainHop === 0) {
      let start = position;
      if (this.stretchAt > 0) {
        const search = Math.max(16, Math.round((this.sourceRate || this.rate) * .006)), stride = Math.max(1, Math.round(search / 64));
        let best = -Infinity, bestOffset = 0;
        const searchFirst = Math.floor(position) - search, searchLast = Math.ceil(position + this.grainHop * ratio) + search;
        let searchReady = searchLast - searchFirst + 1 <= this.grainSource[0].length, count = 0, tailEnergy = 1e-12;
        for (let j = 0; searchReady && j <= searchLast - searchFirst; j++) {
          const frame = this.sourceFrame(searchFirst + j, this.loop), l = this.value(0, frame), r = this.value(1, frame);
          if (l === null || r === null) { searchReady = false; break; }
          this.grainSource[0][j] = l; this.grainSource[1][j] = r;
        }
        for (let j = 0; j < this.grainHop; j += Math.max(1, Math.floor(this.grainHop / 48))) {
          const slot = (at + j) % size, weight = this.stretchWeight[slot];
          const l = weight > 1e-8 ? this.stretchPCM[0][slot] / weight : 0, r = weight > 1e-8 ? this.stretchPCM[1][slot] / weight : 0;
          this.correlationTail[0][count] = l; this.correlationTail[1][count] = r;
          this.correlationOffsets[count] = Math.round(position + j * ratio) - searchFirst; tailEnergy += l * l + r * r; count++;
        }
        // At most 129 candidates × 48 stereo samples, independent of song length.
        for (let offset = -search; searchReady && offset <= search; offset += stride) {
          let dot = 0, sourceEnergy = 1e-12;
          for (let j = 0; j < count; j++) {
            const source = this.correlationOffsets[j] + offset, l = this.grainSource[0][source], r = this.grainSource[1][source];
            const previousL = this.correlationTail[0][j], previousR = this.correlationTail[1][j];
            dot += l * previousL + r * previousR; sourceEnergy += l * l + r * r;
          }
          const score = dot / Math.sqrt(sourceEnergy * tailEnergy) - Math.abs(offset) / search * .001;
          if (score > best) { best = score; bestOffset = offset; }
        }
        start += bestOffset;
      }
      // Stage the entire bounded grain before committing, so a cold page cannot
      // partially write a grain or advance the audible source clock.
      if (!this.readGrain(start, ratio)) return false;
      for (let j = 0; j < this.grainFrames; j++) {
        const slot = (at + j) % size, weight = this.grainWindow[j];
        this.stretchPCM[0][slot] += this.grainPCM[0][j] * weight;
        this.stretchPCM[1][slot] += this.grainPCM[1][j] * weight; this.stretchWeight[slot] += weight;
      }
    }
    const weight = this.stretchWeight[at];
    this.readLeft = weight > 1e-8 ? this.stretchPCM[0][at] / weight : 0;
    this.readRight = weight > 1e-8 ? this.stretchPCM[1][at] / weight : 0;
    this.stretchPCM[0][at] = this.stretchPCM[1][at] = this.stretchWeight[at] = 0;
    this.stretchAt++; return true;
  }
  readGrain(start, ratio) {
    if (Math.abs(ratio - 1) < 1e-10) start = Math.round(start);
    const { phases, banks, logStep, bankTaps, bankOffsets, weights } = this.kernels;
    const bankPosition = Math.min(banks, Math.max(0, Math.log(Math.max(1, ratio)) / logStep * banks));
    let bank = Math.min(banks - 1, Math.floor(bankPosition)), bankMix = bankPosition - bank;
    if (bankMix < 1e-10) bankMix = 0;
    else if (bankMix > 1 - 1e-10) { bank++; bankMix = 0; }
    const lowerTaps = bankTaps[bank], taps = bankMix === 0 ? lowerTaps : bankTaps[bank + 1], lowerOffset = (taps - lowerTaps) / 2;
    const exact = Math.abs(ratio - 1) < 1e-10 && Math.abs(start - Math.round(start)) < 1e-10;
    const first = Math.floor(start) - (exact ? 0 : taps / 2 - 1), last = Math.ceil(start + (this.grainFrames - 1) * ratio) + (exact ? 0 : taps / 2 + 1);
    const count = last - first + 1;
    if (count > this.grainSource[0].length) return false;
    for (let j = 0; j < count; j++) {
      const frame = this.sourceFrame(first + j, this.loop), l = this.value(0, frame), r = this.value(1, frame);
      if (l === null || r === null) return false;
      this.grainSource[0][j] = l; this.grainSource[1][j] = r;
    }
    if (exact) {
      for (let j = 0; j < this.grainFrames; j++) { this.grainPCM[0][j] = this.grainSource[0][j]; this.grainPCM[1][j] = this.grainSource[1][j]; }
      return true;
    }
    for (let j = 0; j < this.grainFrames; j++) {
      const frame = start + j * ratio, center = Math.floor(frame), phasePosition = (frame - center) * phases;
      const phase = Math.min(phases - 1, Math.floor(phasePosition)), phaseMix = phasePosition - phase;
      const a = bankOffsets[bank] + phase * lowerTaps, b = bankOffsets[Math.min(banks, bank + 1)] + phase * taps;
      const offset = center - (taps / 2 - 1) - first; let l = 0, r = 0;
      for (let tap = 0; tap < taps; tap++) {
        const lowerTap = tap - lowerOffset;
        const lower = lowerTap < 0 || lowerTap >= lowerTaps ? 0 : weights[a + lowerTap] + (weights[a + lowerTaps + lowerTap] - weights[a + lowerTap]) * phaseMix;
        const weight = bankMix === 0 ? lower : lower + (weights[b + tap] + (weights[b + taps + tap] - weights[b + tap]) * phaseMix - lower) * bankMix;
        l += this.grainSource[0][offset + tap] * weight; r += this.grainSource[1][offset + tap] * weight;
      }
      this.grainPCM[0][j] = l; this.grainPCM[1][j] = r;
    }
    return true;
  }
  value(channel, position) {
    const at = Math.max(0, Math.min(this.total - 1, position)), i = Math.floor(at), index = Math.floor(i / this.pageFrames);
    const page = this.pages.get(index); if (!page) { this.missing = index; return null; }
    const a = page[channel] ?? page[0], offset = i - index * this.pageFrames;
    const next = offset + 1 < a.length ? a[offset + 1] : (this.pages.get(index + 1)?.[channel]?.[0] ?? a[offset]);
    const value = (a[offset] ?? 0) + ((next ?? 0) - (a[offset] ?? 0)) * (at - i);
    const previous = this.previousPages.get(index);
    if (!previous) return value;
    if (this.clock >= previous.until) { this.previousPages.delete(index); return value; }
    const old = previous.channels[channel] ?? previous.channels[0];
    const before = (old[offset] ?? 0) + ((old[offset + 1] ?? old[offset] ?? 0) - (old[offset] ?? 0)) * (at - i);
    const wet = Math.max(0, 1 - (previous.until - this.clock) / Math.round(this.rate * .012));
    return before * (1 - wet) + value * wet;
  }
  sourceFrame(frame, loop) {
    if (loop && (frame < loop.start || frame >= loop.end)) {
      const length = loop.end - loop.start;
      frame = Math.round(loop.start + ((frame - loop.start) % length + length) % length);
      frame = Math.max(Math.ceil(loop.start), Math.min(Math.ceil(loop.end) - 1, frame));
    }
    return Math.max(0, Math.min(this.total - 1, frame));
  }
  readyForRead(position, loop) {
    const step = Math.max(Math.abs(this.speed), Math.abs(this.targetSpeed)) * (this.sourceRate || this.rate) / this.rate;
    const center = Math.floor(position), exact = Math.abs(step - 1) < 1e-10 && Math.abs(position - center) < 1e-10;
    const bankPosition = Math.min(this.kernels.banks, Math.max(0, Math.log(Math.max(1, step)) / this.kernels.logStep * this.kernels.banks));
    const taps = this.kernels.bankTaps[Math.min(this.kernels.banks, Math.floor(bankPosition) + 1)];
    const first = exact ? center : center - (taps / 2 - 1), last = exact ? center : first + taps - 1;
    for (let frame = first; frame <= last; frame++) {
      const index = Math.floor(this.sourceFrame(frame, loop) / this.pageFrames);
      if (!this.pages.has(index)) { this.missing = index; return false; }
    }
    return true;
  }
  /** Read both channels using one timing/filter decision. Missing halos freeze the source clock. */
  read(position, step) {
    const at = Math.max(0, Math.min(this.total - 1, position)), center = Math.floor(at), fraction = at - center;
    // Normal same-rate playback remains an exact source-sample path.
    if (Math.abs(Math.abs(step) - 1) < 1e-10 && fraction < 1e-10) {
      const left = this.value(0, center), right = this.value(1, center);
      this.readLeft = left ?? 0; this.readRight = right ?? 0; return left !== null && right !== null;
    }
    const { phases, banks, logStep, bankTaps, bankOffsets, weights } = this.kernels;
    const bankPosition = Math.min(banks, Math.max(0, Math.log(Math.max(1, Math.abs(step))) / logStep * banks));
    let bank = Math.min(banks - 1, Math.floor(bankPosition)), bankMix = bankPosition - bank;
    if (bankMix < 1e-10) bankMix = 0;
    else if (bankMix > 1 - 1e-10) { bank++; bankMix = 0; }
    const phasePosition = fraction * phases, phase = Math.min(phases - 1, Math.floor(phasePosition)), phaseMix = phasePosition - phase;
    const singleWeight = bankMix === 0 && phaseMix === 0;
    const lowerTaps = bankTaps[bank], taps = bankMix === 0 ? lowerTaps : bankTaps[bank + 1], lowerOffset = (taps - lowerTaps) / 2;
    const a = bankOffsets[bank] + phase * lowerTaps, b = bankOffsets[Math.min(banks, bank + 1)] + phase * taps;
    let left = 0, right = 0, pageIndex = -1, page = null, previous = null, pageMix = 1;
    const first = center - (taps / 2 - 1), loop = this.loop;
    for (let tap = 0; tap < taps; tap++) {
      // Periodically extend the selected loop, rather than leaking adjacent music into its filter.
      const frame = this.sourceFrame(first + tap, loop);
      const index = Math.floor(frame / this.pageFrames);
      if (index !== pageIndex) {
        pageIndex = index; page = this.pages.get(index);
        if (!page) { this.missing = index; this.readLeft = this.readRight = 0; return false; }
        previous = this.previousPages.get(index);
        if (previous && this.clock >= previous.until) { this.previousPages.delete(index); previous = null; }
        pageMix = previous ? Math.max(0, 1 - (previous.until - this.clock) / Math.round(this.rate * .012)) : 1;
      }
      const offset = frame - pageIndex * this.pageFrames;
      let l = page[0][offset] ?? 0, r = (page[1] ?? page[0])[offset] ?? 0;
      if (previous) {
        const oldLeft = previous.channels[0], oldRight = previous.channels[1] ?? oldLeft;
        l = (oldLeft[offset] ?? 0) * (1 - pageMix) + l * pageMix;
        r = (oldRight[offset] ?? 0) * (1 - pageMix) + r * pageMix;
      }
      let weight;
      if (singleWeight) weight = weights[a + tap];
      else {
        const lowerTap = tap - lowerOffset;
        const lower = lowerTap < 0 || lowerTap >= lowerTaps ? 0 : weights[a + lowerTap] + (weights[a + lowerTaps + lowerTap] - weights[a + lowerTap]) * phaseMix;
        if (bankMix === 0) weight = lower;
        else {
          const upper = weights[b + tap] + (weights[b + taps + tap] - weights[b + tap]) * phaseMix;
          weight = lower + (upper - lower) * bankMix;
        }
      }
      left += l * weight; right += r * weight;
    }
    this.readLeft = left; this.readRight = right; return true;
  }
  process(output) {
    const contextFrame = typeof currentFrame === 'number' ? currentFrame : null;
    for (let i = 0; i < output[0].length; i++, this.clock++) {
      this.updateTempo(this.position);
      if (this.pending && (this.pending.atFrame !== null && contextFrame !== null ? contextFrame + i >= this.pending.atFrame : this.clock >= this.pending.clock)) {
        const target = this.pending.action === "loop" ? this.loopRange(this.pending).start : this.pending.frame ?? (this.pending.action === "unloop" ? (this.pending.slip ? this.shadow : this.loop?.end ?? this.position) : this.position);
        // A cold cue waits while current music keeps playing, then uses the next beat.
        const loop = this.pending.action === "loop" ? this.loopRange(this.pending) : this.pending.action === "seek" || this.pending.action === "unloop" ? null : this.loop;
        if (this.readyForRead(target, loop)) { this.apply(this.pending); this.pending = null; }
        else { const retry = this.running ? this.pending.retryFrames : 128; this.pending.clock += retry; if (this.pending.atFrame !== null) this.pending.atFrame += retry; }
      }
      const held = this.scratchSpeed !== null;
      const scratch = held && this.clock - this.scratchAt > this.rate * .09 ? 0 : this.scratchSpeed;
      let target = held ? scratch : this.targetSpeed * (this.effect === "reverse" ? -1 : 1);
      if (this.effect === "brake" && !held) { this.targetSpeed = Math.max(.00001, this.targetSpeed * .99992); target = this.targetSpeed; }
      this.speed += (target - this.speed) * .003;
      if (Math.abs(target - this.speed) < 1e-10) this.speed = target;
      const active = this.running && (this.startAtFrame !== null && contextFrame !== null ? contextFrame + i >= this.startAtFrame : this.clock >= this.startClock) && !this.ended;
      const sourceRate = this.sourceRate || this.rate;
      const stretch = this.keyLock && !held && this.effect !== "reverse" && this.effect !== "brake" && this.speed > 0 && Math.abs(this.speed - 1) > .000001;
      if (stretch !== this.stretchActive) { this.resetStretch(); this.stretchActive = stretch; }
      const ready = !active || (stretch ? this.readStretched(this.position) : this.read(this.position, this.speed * sourceRate / this.rate));
      const left = active && ready ? this.readLeft : 0, right = active && ready ? this.readRight : 0;
      const audible = active && ready && Math.abs(this.speed) > .006;
      this.gain += ((audible ? 1 : 0) - this.gain) * .012;
      const step = sourceRate * 60 / this.bpm * this.effectBeats;
      const phase = ((this.position - this.beatFrame) % step + step) % step / step;
      const gate = this.effect === "gate" ? Math.min(1, phase / .015, Math.max(0, (.72 - phase) / .015)) : 1;
      const cutoff = this.effect === "filter-sweep" ? 180 * Math.pow(80, 1 - phase) : sourceRate / Math.max(2, Math.abs(this.speed) * 2);
      const coefficient = 1 - Math.exp(-2 * Math.PI * Math.min(cutoff, this.rate * .45) / this.rate);
      const delayFrames = Math.min(this.delay[0].length - 1, Math.max(1, Math.round(this.rate * 60 / this.bpm * this.effectBeats / Math.max(.25, this.targetSpeed))));
      for (let c = 0; c < output.length; c++) {
        let value = ready ? (c ? right : left) : this.last[c] ?? 0;
        this.low[c] += coefficient * (value - this.low[c]);
        if (this.effect === "filter-sweep") value = this.low[c];
        if (this.effect === "echo-out") {
          const echo = this.delay[c][(this.delayAt - delayFrames + this.delay[c].length) % this.delay[c].length];
          this.delay[c][this.delayAt] = value + echo * .42; value = value * .65 + echo * .45;
        } else this.delay[c][this.delayAt] = 0;
        if (this.crossfade) { const mix = this.crossfade / Math.round(this.rate * .005); value = value * (1 - mix) + this.old[c] * mix; }
        value *= this.gain * gate; output[c][i] = Number.isFinite(value) ? value : 0; this.last[c] = output[c][i];
      }
      this.delayAt = (this.delayAt + 1) % this.delay[0].length;
      if (this.crossfade) this.crossfade--;
      if (active && ready) {
        this.position += this.speed * sourceRate / this.rate;
        this.shadow = Math.min(this.total - 1, this.shadow + this.targetSpeed * sourceRate / this.rate);
        if (this.loop) {
          const { start, end } = this.loop, length = end - start;
          if (this.position >= end || this.position < start) this.jump(start + ((this.position - start) % length + length) % length, stretch);
        } else if (this.position >= this.total || this.position < 0) {
          if (held) this.position = Math.max(0, Math.min(this.total - 1, this.position));
          else { this.position = Math.max(0, Math.min(this.total, this.position)); this.ended = true; }
        }
      }
    }
    if (this.clock >= this.reportAt) {
      this.reportAt = this.clock + this.rate / 20;
      for (const [key, previous] of this.previousPages) if (this.clock >= previous.until) this.previousPages.delete(key);
      this.send({ type: "state", frame: Math.round(this.position), shadow: Math.round(this.shadow), speed: this.speed,
        targetSpeed: this.targetSpeed, keyLock: this.keyLock, effect: this.effect, playing: this.running && !this.ended, ended: this.ended, loop: this.loop, queued: !!this.pending, missing: this.missing, clock: this.clock,
        audioTime: typeof currentTime === "number" ? currentTime + output[0].length / this.rate : undefined });
    }
  }
}

if (typeof registerProcessor === "function") registerProcessor("source-deck", class extends AudioWorkletProcessor {
  constructor(options) { super(); this.dsp = new DeckDSP(sampleRate, data => this.port.postMessage(data), options.processorOptions?.readerKernels); this.port.onmessage = event => this.dsp.message(event.data); }
  process(_inputs, outputs) { this.dsp.process(outputs[0]); return true; }
});

