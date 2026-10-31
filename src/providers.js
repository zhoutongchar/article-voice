import { synthesize, listVoices } from './cartesia.js';
import { LOCAL_CONFIG, localSynthesize, localVoices, isReferenceId } from './local.js';

const supportedProvider = provider => provider === 'cartesia' || provider === 'local';

export function normalizeProviderSettings(settings) {
  const profiles = settings.providerProfiles || {};
  const providerProfiles = Object.fromEntries(Object.entries(profiles).filter(([provider]) => supportedProvider(provider)));
  if (supportedProvider(settings.provider)) {
    return Object.keys(profiles).length === Object.keys(providerProfiles).length ? settings : { ...settings, providerProfiles };
  }
  // A removed provider must recover to local speech, without sending text to a
  // paid cloud provider or reusing another narrator's cached audio.
  const voice = LOCAL_CONFIG.voices.find(voice => voice.id === providerProfiles.local?.voiceId) || LOCAL_CONFIG.voices[0];
  return { ...settings, providerProfiles, provider: 'local', model: LOCAL_CONFIG.model,
    voiceId: voice.id, voiceName: voice.name, voiceLibrary: [],
    language: LOCAL_CONFIG.languages[settings.language] ? settings.language : '' };
}

export const canGenerate = settings => !!settings.voiceId && (settings.provider === 'local' ? isReferenceId(settings.voiceReferenceId) : !!settings.apiKey);
export const generateSpeech = (text, settings, signal) => settings.provider === 'local'
  ? localSynthesize(text, settings, signal) : synthesize(text, settings, signal);
export const providerVoices = (key, options) => options.provider === 'local'
  ? localVoices(key, options) : listVoices(key, options);
