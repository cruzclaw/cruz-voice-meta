// The hidden audio page: owns the microphone and the speaker. All decisions are made in the main process.
const RATE = 24000;
const context = new AudioContext({ sampleRate: RATE });

// Short generated tones, so there are no sound files to ship. Notes are [Hz, seconds].
const CHIMES = {
  listening: [[660, 0.07], [880, 0.09]], // rising: go ahead
  thinking: [[520, 0.06], [390, 0.12]], // falling: heard you, working on it
  cancelled: [[500, 0.07], [360, 0.07]], // quick and low: nothing heard
};
let chimeEndsAt = 0;

function chime(kind) {
  const notes = CHIMES[kind];
  if (!notes) return;
  void context.resume();
  let at = context.currentTime + 0.01;
  for (const [hz, seconds] of notes) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = hz;
    // A quick fade in and out keeps the tone from clicking.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.14, at + 0.012);
    gain.gain.linearRampToValueAtTime(0, at + seconds);
    osc.connect(gain).connect(context.destination);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
    at += seconds;
  }
  chimeEndsAt = at;
}

let stream;
let source;
let node;
let starting = false;
// Set by the main process. If listening was cancelled while the microphone was still opening, do not open it.
let wanted = false;
// The microphone is open for either reason: listening to the person, or waiting for the wake phrase.
let forListening = false;
let forWake = false;

async function startCapture() {
  wanted = forListening || forWake;
  if (stream || starting) return;
  starting = true;
  try {
    await context.resume();
    // Do not open the microphone until the chime has finished, or it would record the chime.
    const wait = (chimeEndsAt - context.currentTime) * 1000 + 60;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await context.audioWorklet.addModule('audio-worklet.js');
    if (!wanted) return;
    stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation keeps the assistant's own voice out of the microphone.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!wanted) {
      releaseMic();
      return;
    }
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
    wanted = false;
    releaseMic();
  } finally {
    starting = false;
  }
}

function releaseMic() {
  if (node) node.port.onmessage = null;
  if (source) source.disconnect();
  if (node) node.disconnect();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = source = node = undefined;
}

// Called when one reason to hold the microphone ends. It closes only if no reason is left.
function stopCapture() {
  wanted = forListening || forWake;
  if (!wanted) releaseMic();
}

// Everything the assistant says goes through this analyser, so the panel can move with its voice.
const speaker = context.createGain();
const analyser = context.createAnalyser();
analyser.fftSize = 512;
speaker.connect(analyser);
analyser.connect(context.destination);
const samplesBuffer = new Float32Array(analyser.fftSize);
let wasSounding = false;
setInterval(() => {
  if (playing.size === 0) {
    if (wasSounding) window.hostAudio.sendOutLevel(0);
    wasSounding = false;
    return;
  }
  analyser.getFloatTimeDomainData(samplesBuffer);
  let sum = 0;
  for (let i = 0; i < samplesBuffer.length; i++) sum += samplesBuffer[i] * samplesBuffer[i];
  wasSounding = true;
  window.hostAudio.sendOutLevel(Math.sqrt(sum / samplesBuffer.length));
}, 50);

window.hostAudio.info(`audio ready: ${context.state} at ${context.sampleRate} Hz`);
let playAt = 0;
const playing = new Set();

let playedSamples = 0;
let peak = 0;
// Chunks started since playback last stopped. The main process compares it with how many it sent.
let chunkCount = 0;
// How many times playback was stopped. Reports carry it, so one from before a stop is never taken for a later reply.
let stops = 0;

function play(pcm) {
  if (context.state !== 'running') void context.resume();
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  if (!samples.length) return;
  const buffer = context.createBuffer(1, samples.length, RATE);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    data[i] = samples[i] / 0x8000;
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(speaker);
  // Chain chunks back to back, with a small lead so the first one is not clipped.
  const first = playing.size === 0;
  playAt = Math.max(playAt, context.currentTime + 0.05);
  const startsAt = playAt;
  node.start(startsAt);
  playAt += buffer.duration;
  playing.add(node);
  if (first) reportWhenAudible(startsAt);
  if (playedSamples === 0) window.hostAudio.info(`speaker: first chunk, audio ${context.state} at ${context.sampleRate} Hz`);
  playedSamples += samples.length;
  chunkCount++;
  node.onended = () => {
    playing.delete(node);
    if (playing.size === 0) window.hostAudio.drained(chunkCount);
  };
}

// Playback has really begun when the first chunk's start time has come, plus what the output device adds. Until
// then the sound is only scheduled. A stop in between cancels the report.
function reportWhenAudible(startsAt) {
  const mine = stops;
  const wait = Math.max(0, (startsAt - context.currentTime + (context.outputLatency || 0)) * 1000);
  setTimeout(() => {
    if (stops === mine) window.hostAudio.started(stops);
  }, wait);
}

function stopPlayback() {
  stops++;
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
  chunkCount = 0;
  if (playedSamples) window.hostAudio.info(`speaker: ${(playedSamples / RATE).toFixed(1)} s of speech scheduled`);
  playedSamples = 0;
}

// Speech ends on its own when the queue drains, so report once the last chunk finishes.
setInterval(() => {
  if (playedSamples && playing.size === 0) {
    window.hostAudio.info(`speaker: ${(playedSamples / RATE).toFixed(1)} s of speech played, loudest sample ${peak.toFixed(2)}`);
    playedSamples = 0;
    peak = 0;
  }
}, 500);

// A plain tone, to tell apart "no sound from this app at all" from "the speech is silent".
function beep() {
  void context.resume();
  const osc = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.2;
  osc.frequency.value = 440;
  osc.connect(gain).connect(context.destination);
  osc.start();
  osc.stop(context.currentTime + 0.6);
  window.hostAudio.info(`test tone played, audio ${context.state}`);
}

window.hostAudio.onBeep(beep);
window.hostAudio.onChime(chime);
window.hostAudio.onCapture((on) => {
  forListening = on;
  if (on) startCapture();
  else stopCapture();
});
window.hostAudio.onWake((on) => {
  forWake = on;
  if (on) startCapture();
  else stopCapture();
});
window.hostAudio.onPlay(play);
window.hostAudio.onStopPlayback(stopPlayback);

// Everything above is in place, so the main process can now send instructions. Anything it sent earlier was lost.
window.hostAudio.ready();
