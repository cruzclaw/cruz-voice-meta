// Runs on the audio thread. Collects microphone samples into 40 ms frames of 16-bit PCM.
const FRAME_SAMPLES = 960; // 40 ms at 24 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === FRAME_SAMPLES) {
        const out = this.buffer.buffer;
        this.port.postMessage(out, [out]);
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
