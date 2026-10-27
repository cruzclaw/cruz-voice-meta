// The hidden audio page: owns the microphone and the speaker. All decisions are made in the main process.
const RATE = 24000;
const context = new AudioContext({ sampleRate: RATE });

let stream;
let source;
let node;
let starting = false;

async function startCapture() {
  if (stream || starting) return;
  starting = true;
  try {
    await context.resume();
    await context.audioWorklet.addModule('audio-worklet.js');
    stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation keeps the assistant's own voice out of the microphone.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'capture-processor');
    node.port.onmessage = (event) => {
      window.hostAudio.sendMic(event.data);
      const samples = new Int16Array(event.data);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      window.hostAudio.sendLevel(Math.sqrt(sum / samples.length) / 32768);
    };
    window.hostAudio.info(`microphone open at ${context.sampleRate} Hz, audio ${context.state}`);
    source.connect(node);
  } catch (e) {
    window.hostAudio.reportError(e && e.message ? e.message : e);
    stopCapture();
  } finally {
    starting = false;
  }
}

function stopCapture() {
  if (node) node.port.onmessage = null;
  if (source) source.disconnect();
  if (node) node.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = source = node = undefined;
}

window.hostAudio.info(`audio ready: ${context.state} at ${context.sampleRate} Hz`);
let playAt = 0;
const playing = new Set();

let playedSamples = 0;

function play(pcm) {
  if (context.state !== 'running') void context.resume();
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  if (!samples.length) return;
  const buffer = context.createBuffer(1, samples.length, RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 0x8000;
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  // Chain chunks back to back, with a small lead so the first one is not clipped.
  playAt = Math.max(playAt, context.currentTime + 0.05);
  node.start(playAt);
  playAt += buffer.duration;
  playing.add(node);
  if (playedSamples === 0) window.hostAudio.info(`speaker: first chunk, audio ${context.state} at ${context.sampleRate} Hz`);
  playedSamples += samples.length;
  node.onended = () => playing.delete(node);
}

function stopPlayback() {
  for (const node of playing) {
    node.onended = null;
    try {
      node.stop();
    } catch {
      // Already finished.
    }
  }
  playing.clear();
  playAt = 0;
  if (playedSamples) window.hostAudio.info(`speaker: ${(playedSamples / RATE).toFixed(1)} s of speech scheduled`);
  playedSamples = 0;
}

// Speech ends on its own when the queue drains, so report once the last chunk finishes.
setInterval(() => {
  if (playedSamples && playing.size === 0) {
    window.hostAudio.info(`speaker: ${(playedSamples / RATE).toFixed(1)} s of speech played`);
    playedSamples = 0;
  }
}, 500);

window.hostAudio.onCapture((on) => (on ? startCapture() : stopCapture()));
window.hostAudio.onPlay(play);
window.hostAudio.onStopPlayback(stopPlayback);
