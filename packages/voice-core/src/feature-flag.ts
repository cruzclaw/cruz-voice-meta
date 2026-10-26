/**
 * Voice feature flag. Source of truth is a per-user setting on the server,
 * returned in the session bootstrap. The default is OFF. Hiding the UI is a
 * convenience only: the voice gateway must also refuse sessions when it is off.
 */
export interface VoiceFeatureConfig {
  voiceEnabled: boolean;
  /** Wake-phrase monitoring needs its own explicit opt-in. */
  wakePhraseConsent: boolean;
}

export const VOICE_FEATURE_DEFAULT: VoiceFeatureConfig = {
  voiceEnabled: false,
  wakePhraseConsent: false,
};

/** Anything missing or malformed resolves to OFF. */
export function parseVoiceFeatureConfig(raw: unknown): VoiceFeatureConfig {
  if (!raw || typeof raw !== 'object') return { ...VOICE_FEATURE_DEFAULT };
  const r = raw as Record<string, unknown>;
  const voiceEnabled = r.voiceEnabled === true;
  return {
    voiceEnabled,
    // Consent counts only while the feature itself is on.
    wakePhraseConsent: voiceEnabled && r.wakePhraseConsent === true,
  };
}
