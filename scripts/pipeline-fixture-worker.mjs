// Headless access to the production assembler, planner and source projection.
import readline from 'node:readline';
import { continuousUnit } from '../src/continuous-text.js';
import { contentChunksFromUnit, planSpeech, projectPlayable } from '../src/pipeline/contracts.js';

async function fixtures() {
  const paragraphs = [
    'The morning train follows the river through the valley. A familiar voice reads each complete paragraph while the listener watches the changing landscape. The next passage should be ready before the current one finishes.',
    'Good timing matters as much as a natural voice. The reader marks the word that is actually being spoken, keeps the surrounding passage visible, and lets the listener move backward or forward without generating the same audio again.',
  ];
  const html = { id: 'fixture-html', source: { format: 'dom' }, blocks: paragraphs };
  const pages = [
    { id: 'fixture-page-1', source: { format: 'ocr' }, blocks: [paragraphs[0].replace('river through', 'river\nthrough'), 'The next page completes a re-'] },
    { id: 'fixture-page-2', source: { format: 'ocr' }, blocks: ['markable thought. A complete sentence follows the repaired word, keeping its original source coordinates.', paragraphs[1]] },
  ];
  for (const page of pages) page.contentChunks = await contentChunksFromUnit({ ...page, stability: 'draft' });
  const assembled = continuousUnit(pages[0], pages.slice(1), new Map());
  return { html: await contentChunksFromUnit(html), ocr: await contentChunksFromUnit(assembled) };
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line);
    const result = request.method === 'fixtures' ? await fixtures()
      : request.method === 'plan' ? await planSpeech(request.content)
      : request.method === 'project' ? await projectPlayable(request.content, request.speech, request.audio, request.alignment)
      : (() => { throw new Error('Unknown fixture operation'); })();
    process.stdout.write(JSON.stringify({ result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message }) + '\n'); }
}
