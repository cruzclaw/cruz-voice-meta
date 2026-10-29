/**
 * The Windows voice host as a library, for an Electron main process.
 *
 *   const host = createVoiceHost({ connection, assetsDir, speechProcessFile, ... });
 *   host.start();
 *   host.setAttention({ counts: { update: 1, approval: 0, acknowledgement: 0, error: 0 } });
 *
 * The page files (panel.html, audio.html and the rest) and the speech process ship next to this file in
 * the package's dist folder. See docs/windows-host.md.
 */
export { createVoiceHost, STATE_TEXT } from './host.js';
export type { AnnounceResult, VoiceHost, VoiceHostOptions } from './host.js';
export { HostController } from './controller.js';
export type { AudioDevice, ControllerOptions, Link, WakeSource } from './controller.js';
export { VoiceClient } from './client.js';
export { ConnectionError, CruzBackendConnection, StaticConnection } from './connection.js';
export type { ConnectionProvider, ConnectionTarget, Credentials, CruzBackendOptions } from './connection.js';
export { DeviceSpeech, SPEECH_FORMAT } from './device-speech.js';
export type { SpeechSource } from './device-speech.js';
export {
  ATTENTION_COLORS,
  ATTENTION_KINDS,
  COMPACT_HEIGHT,
  COMPACT_SIZE,
  COMPACT_WIDTH,
  attentionLabel,
  attentionTotal,
  hueSegments,
  noAttention,
  normalizeAttention,
} from '@cruzclaw/windows-bridge';
export type { AttentionKind, AttentionSummary, DisplayState, PanelState } from '@cruzclaw/windows-bridge';
