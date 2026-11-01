import { nativeRequest } from './native.js';
import connection from '../chrome/connection.json' with { type: 'json' };
const $ = id => document.getElementById(id);
async function connect() {
  $('retry').hidden = true;
  try {
    const value = await nativeRequest('status');
    $('dot').classList.add('ready'); $('status').textContent = 'Chrome is connected';
    $('detail').textContent = value.ready ? 'Your voices are ready. Let’s read something.' : 'The app will prepare your voices automatically when you start reading.';
    $('open-app').hidden = true;
  } catch (error) {
    $('status').textContent = 'One more step'; $('detail').textContent = error.message;
    $('retry').hidden = false; $('open-app').hidden = false;
  }
}
$('retry').onclick = connect;
$('test').onclick = async () => {
  $('test').disabled = true; $('test').textContent = 'Preparing your reading…';
  try {
    await nativeRequest('voices', undefined, undefined, value => { $('detail').textContent = value.message; });
    const tab = await chrome.tabs.create({ url: `http://127.0.0.1:${connection.port}/sample` });
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await chrome.tabs.get(tab.id)).status === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let timer;
    try {
      await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome interrupted opening the reader. Refresh the article and open Article Voice from the Extensions menu.')), 10000); })
      ]);
    } finally { clearTimeout(timer); }
  } catch (error) { $('detail').textContent = error.message; $('open-app').hidden = false; }
  finally { $('test').disabled = false; $('test').textContent = 'Try a reading'; }
};
connect();
