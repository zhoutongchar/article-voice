import { normalizeProviderSettings } from './providers.js';
import { LOCAL_CONFIG } from './local.js';

export function playerPreferences(saved = {}, localOnly = false) {
  let value = normalizeProviderSettings({ provider: 'local', speed: 1, follow: true, ...saved });
  if (localOnly && value.provider !== 'local') {
    const local = value.providerProfiles?.local || {};
    value = { ...value, provider: 'local', voiceId: local.voiceId || '', voiceName: local.voiceName || '',
      voiceLibrary: local.voiceLibrary || [] };
  }
  return { ...value, model: value.provider === 'local' ? LOCAL_CONFIG.model : 'sonic-3.6',
    language: value.provider === 'local' && !LOCAL_CONFIG.languages[value.language] ? '' : value.language || '',
    improveText: value.improveText !== false,
    mode: value.mode === 'ahead' ? 'ahead' : 'stream',
    layout: ['minimal', 'compact', 'full'].includes(value.layout) ? value.layout : 'compact' };
}
