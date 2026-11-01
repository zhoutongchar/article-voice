import connection from '../chrome/connection.json' with { type: 'json' };

export function registerBackground(chrome) {
  const heartbeatAlarm = 'article-voice-connection';
  // Liveness belongs to the background worker, not a reader tab: a cached clip
  // must not make a disabled or removed extension look connected indefinitely.
  const heartbeat = async () => {
    try { await chrome.runtime.sendNativeMessage(connection.host, { method: 'heartbeat' }); }
    catch { /* The companion may not be installed yet. The next alarm retries. */ }
  };
  const ensureAlarm = async () => {
    try {
      if (!await chrome.alarms.get(heartbeatAlarm)) {
        await chrome.alarms.create(heartbeatAlarm, { periodInMinutes: 0.5 });
      }
    } catch { /* Recheck on the next service-worker start. */ }
  };
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === heartbeatAlarm) void heartbeat(); });
  chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); void heartbeat(); });
  void ensureAlarm();
  void heartbeat();
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  chrome.runtime.onInstalled.addListener(details => {
    void ensureAlarm(); void heartbeat();
    if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  });
  chrome.action.onClicked.addListener(async tab => {
    if (!tab.id) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    } catch {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#ad482a' });
      await chrome.action.setTitle({ tabId: tab.id, title: 'Article Voice cannot read this browser page. Open a normal article tab.' });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'follow-state' && sender.frameId === 0 && sender.tab?.id
      && Number.isFinite(message.pausedUntil) && message.pausedUntil >= 0) {
      chrome.runtime.sendMessage({ type: 'follow-state', tabId: sender.tab.id, pausedUntil: message.pausedUntil })
        .then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
      return true;
    }
    if (message?.type === 'seek-word' && sender.frameId === 0 && sender.tab?.id
      && Number.isInteger(message.block) && message.block >= 0 && Number.isInteger(message.start)
      && Number.isInteger(message.end) && message.start >= 0 && message.end > message.start) {
      chrome.runtime.sendMessage({ type: 'seek-word', tabId: sender.tab.id,
        block: message.block, start: message.start, end: message.end })
        .then(() => reply({ ok: true })).catch(() => reply({ ok: false, error: 'Reopen the reader to click words.' }));
      return true;
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL('player.html'))) return;
    const tabId = sender.tab?.id;
    if (!tabId) { reply({ ok: false, error: 'Open Article Voice from an article tab.' }); return; }
    if (message?.type === 'identify') { reply({ ok: true, value: { tabId } }); return; }
    chrome.tabs.sendMessage(tabId, message).then(reply).catch(() => reply({ ok: false, error: 'The article changed. Close the player and reopen it.' }));
    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) registerBackground(chrome);
