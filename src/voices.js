export const isReferenceId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

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

export const PREVIEW_TEXT = 'Take a moment to listen. This is how your articles will sound with this voice.';
