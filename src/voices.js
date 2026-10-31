export const VOICE_STYLES = [
  { id: '', name: 'All styles', query: '' },
  { id: 'warm', name: 'Warm', query: 'warm' },
  { id: 'calm', name: 'Calm', query: 'calm' },
  { id: 'expressive', name: 'Expressive', query: 'expressive' },
  { id: 'narration', name: 'Narration', query: 'narration' },
  { id: 'conversational', name: 'Conversational', query: 'conversational' }
];

export function parseVoice(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) return null;
  const voice = { id: value.id, name: value.name };
  for (const key of ['description', 'tagline', 'language', 'gender', 'referenceId'])
    if (typeof value[key] === 'string') voice[key] = value[key];
  if (Array.isArray(value.accents)) voice.accents = value.accents.filter(a => a && typeof a.accent === 'string')
    .map(a => ({ accent: a.accent, ...(typeof a.locale === 'string' ? { locale: a.locale } : {}),
      ...(typeof a.is_native === 'boolean' ? { is_native: a.is_native } : {}) }));
  return voice;
}

export function voiceLabel(voice) {
  const gender = { feminine: 'Female', masculine: 'Male', gender_neutral: 'Neutral' }[voice.gender];
  const accent = voice.accents?.find(a => a.is_native)?.accent.replaceAll('-', ' ');
  return [voice.name, gender, accent || voice.language].filter(Boolean).join(' · ');
}

export function voiceSearch(style, query) {
  return [VOICE_STYLES.find(item => item.id === style)?.query, query.trim()].filter(Boolean).join(' ');
}

export const PREVIEW_TEXT = 'Take a moment to listen. This is how your articles will sound with this voice.';
