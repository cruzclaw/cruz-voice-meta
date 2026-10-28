/** The speech the live test uses. Made by Kokoro in a separate process, because Kokoro and sherpa-onnx each load their own onnxruntime.dll and cannot share a process. */
export interface LiveClip {
  name: string;
  text: string;
  voice: string;
  /** wake: the detector must hear the phrase. quiet: it must stay silent. */
  expect: 'wake' | 'quiet';
}

export const LIVE_CLIPS: readonly LiveClip[] = [
  { name: 'hey', text: 'Hey Cruz.', voice: 'af_heart', expect: 'wake' },
  { name: 'hi-long', text: 'Hi Cruz, what is on my calendar today?', voice: 'am_adam', expect: 'wake' },
  { name: 'hello', text: 'Hello Cruz.', voice: 'bf_emma', expect: 'wake' },
  { name: 'okay-long', text: 'Okay Cruz, send an email to Maria.', voice: 'bm_george', expect: 'wake' },
  { name: 'weather', text: 'What is the weather like today?', voice: 'af_heart', expect: 'quiet' },
  { name: 'siri', text: 'Hey Siri, set a timer for ten minutes.', voice: 'am_adam', expect: 'quiet' },
  { name: 'everyone', text: 'Hello everyone, welcome to the meeting.', voice: 'bf_emma', expect: 'quiet' },
  { name: 'cruise', text: 'We are going on a cruise next month.', voice: 'af_bella', expect: 'quiet' },
  { name: 'crews', text: 'The crews arrived at the site early.', voice: 'bm_george', expect: 'quiet' },
  { name: 'cruise-control', text: 'The cruise control is not working.', voice: 'am_adam', expect: 'quiet' },
];
