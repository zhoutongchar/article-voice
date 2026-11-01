export const bridge = {
  async request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The article is no longer available.');
    return response.value;
  },
  async settings() { return chrome.storage.local.get(['provider', 'providerProfiles', 'apiKey', 'voiceId', 'voiceName', 'voiceLibrary', 'language', 'speed', 'mode', 'follow', 'layout']); },
  async save(value) { await chrome.storage.local.set(value); },
  async subscribe(callback) {
    const { tabId } = await this.request({ type: 'identify' });
    const listener = (message, sender) => {
      if (sender.id === chrome.runtime.id && ['seek-word', 'follow-state'].includes(message?.type) && message.tabId === tabId) callback(message);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }
};
