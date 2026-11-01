"""Version 1 pipeline artifacts. UTF-16 text ranges and exclusive sample ranges.

Artifacts are immutable values; execution state belongs to the scheduler.
The wire schema and cross-language examples live in pipeline/.
"""
import hashlib
import json
import re
import unicodedata
from text_cleanup import utf16_length, source_spans

VERSION = 1
MAX_TEXT = 12000
HEX = re.compile(r'^[0-9a-f]{64}$')

class PipelineError(ValueError):
    def __init__(self, code, message, stage='contract', retryable=False):
        super().__init__(message)
        self.code, self.stage, self.retryable = code, stage, retryable


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def identity(value):
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def artifact(kind, **body):
    value = {'schemaVersion': VERSION, 'kind': kind, **body}
    return {'id': identity(value), **value}


def require(condition, message='Invalid pipeline artifact'):
    if not condition: raise PipelineError('INVALID_ARTIFACT', message)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def span(value, length, empty=False):
    return isinstance(value, dict) and integer(value.get('start')) and integer(value.get('end')) and 0 <= value['start'] <= value['end'] <= length and (empty or value['start'] < value['end'])


def base(value, kind):
    require(isinstance(value, dict) and value.get('schemaVersion') == VERSION and value.get('kind') == kind)
    require(isinstance(value.get('id'), str) and HEX.fullmatch(value['id']))
    require(value['id'] == identity({k: v for k, v in value.items() if k != 'id'}), 'Pipeline artifact identity changed')
    return value


def content(value):
    base(value, 'content')
    require(isinstance(value.get('text'), str) and 0 < utf16_length(value['text']) <= MAX_TEXT)
    length = utf16_length(value['text'])
    require(value.get('stability') in ('draft', 'sealed') and isinstance(value.get('streamId'), str) and integer(value.get('sequence')))
    require(isinstance(value.get('parentIds'), list) and all(isinstance(x, str) for x in value['parentIds']))
    require(isinstance(value.get('paragraphs'), list) and value['paragraphs'])
    previous = 0
    for paragraph in value['paragraphs']:
        require(span(paragraph, length) and paragraph['start'] >= previous)
        previous = paragraph['end']
    previous = 0
    require(isinstance(value.get('sourceMap'), list))
    for item in value['sourceMap']:
        require(span(item, length) and item['start'] == previous and type(item.get('identity')) is bool and isinstance(item.get('sources'), list))
        for ref in item['sources']:
            require(isinstance(ref, dict) and isinstance(ref.get('unitId'), str) and isinstance(ref.get('revision'), str) and integer(ref.get('block')))
            require(integer(ref.get('start')) and integer(ref.get('end'), 1) and ref['end'] > ref['start'])
        require(not item['identity'] or len(item['sources']) == 1 and item['end'] - item['start'] == item['sources'][0]['end'] - item['sources'][0]['start'])
        previous = item['end']
    require(previous == length, 'Incomplete content source mapping')
    return value


def speech(value):
    base(value, 'speech')
    require(isinstance(value.get('parentId'), str) and HEX.fullmatch(value['parentId']) and integer(value.get('sequence')))
    require(isinstance(value.get('text'), str) and 0 < utf16_length(value['text']) <= MAX_TEXT)
    require(value.get('textDigest') == digest(value['text']))
    require(span(value.get('range'), MAX_TEXT) and value['range']['end'] - value['range']['start'] == utf16_length(value['text']))
    require(isinstance(value.get('policy'), str))
    return value


def audio(value, pcm=None):
    base(value, 'audio')
    require(value.get('format') == 'pcm_s16le' and value.get('sampleRate') == 24000 and value.get('channels') == 1 and integer(value.get('frames'), 1))
    require(all(isinstance(value.get(k), str) and HEX.fullmatch(value[k]) for k in ('textDigest', 'pcmDigest', 'referenceId', 'generationId')))
    require(isinstance(value.get('modelRevision'), str) and isinstance(value.get('voiceId'), str))
    if pcm is not None: require(len(pcm) == value['frames'] * 2 and digest(pcm) == value['pcmDigest'], 'Audio bytes do not match their artifact')
    return value


def alignment(value, spoken, sound):
    base(value, 'alignment'); speech(spoken); audio(sound)
    require(value.get('audioId') == sound['id'] and value.get('textDigest') == spoken['textDigest'] == sound['textDigest'], 'Alignment belongs to different text or audio')
    require(value.get('sampleRate') == sound['sampleRate'] and value.get('frames') == sound['frames'] and isinstance(value.get('alignerRevision'), str))
    require(isinstance(value.get('words'), list) and value['words'])
    previous = 0
    for word in value['words']:
        require(isinstance(word.get('text'), str) and span({'start': word.get('startSample'), 'end': word.get('endSample')}, sound['frames'], True))
        require(word['startSample'] >= previous)
        require(word.get('range') is None or span(word['range'], utf16_length(spoken['text'])))
        previous = word['startSample']
    require(isinstance(value.get('unmapped'), list) and all(span(item, utf16_length(spoken['text'])) for item in value['unmapped']))
    return value


def source_ranges(chunk, start, end):
    refs = []
    for item in chunk['sourceMap']:
        if start >= item['end'] or end <= item['start']: continue
        for source in item['sources']:
            ref = dict(source)
            if item['identity']:
                ref['start'] += max(start, item['start']) - item['start']
                ref['end'] = source['start'] + min(end, item['end']) - item['start']
            if refs and all(ref.get(k) == refs[-1].get(k) for k in ('unitId', 'revision', 'block')) and ref['start'] <= refs[-1]['end']:
                refs[-1]['end'] = max(refs[-1]['end'], ref['end'])
            else: refs.append(ref)
    return refs


def transform(chunk, record):
    content(chunk)
    if record['text'] == chunk['text']: return chunk
    mapping = []
    for item in record['spans']:
        if item['end'] == item['start']: continue
        if item['identity']:
            for old in chunk['sourceMap']:
                start, end = max(old['start'], item['from']), min(old['end'], item['to'])
                if end <= start: continue
                mapping.append({'start': item['start'] + start - item['from'], 'end': item['start'] + end - item['from'],
                                'identity': old['identity'], 'sources': source_ranges(chunk, start, end)})
        else:
            mapping.append({'start': item['start'], 'end': item['end'], 'identity': False,
                            'sources': source_ranges(chunk, item['from'], item['to'])})
    paragraphs = []
    for paragraph in chunk['paragraphs']:
        hits = [item for item in record['spans'] if paragraph['start'] < item['to'] and paragraph['end'] > item['from'] and item['end'] > item['start']]
        require(hits, 'A formatted paragraph lost its source text')
        first, last = hits[0], hits[-1]
        start = first['start'] + max(0, paragraph['start'] - first['from']) if first['identity'] else first['start']
        end = last['end'] - max(0, last['to'] - paragraph['end']) if last['identity'] else last['end']
        paragraphs.append({'start': start, 'end': end})
    return content(artifact('content', parentIds=[chunk['id']], streamId=chunk['streamId'], sequence=chunk['sequence'],
                            stability=chunk['stability'], text=record['text'], paragraphs=paragraphs, sourceMap=mapping))


def locate_words(text, measured, frames, rate, audio_id, revision):
    normalized, positions, offset = [], [], 0
    canon = lambda value: ''.join(c for c in unicodedata.normalize('NFKC', value).lower() if c.isalnum())
    for char in text:
        width = utf16_length(char)
        for c in canon(char): normalized.append(c); positions.append((offset, offset + width))
        offset += width
    haystack, cursor, words, covered = ''.join(normalized), 0, [], []
    for item in measured:
        target = canon(item['word']); found = haystack.find(target, cursor) if target else -1
        location = None
        if found >= 0:
            location = {'start': positions[found][0], 'end': positions[found + len(target) - 1][1]}
            cursor = found + len(target); covered.append(location)
        words.append({'text': item['word'], 'startSample': round(item['start'] * rate), 'endSample': min(frames, round(item['end'] * rate)), 'range': location})
    missing, cursor = [], 0
    for item in covered:
        if item['start'] > cursor: missing.append({'start': cursor, 'end': item['start']})
        cursor = max(cursor, item['end'])
    if cursor < utf16_length(text): missing.append({'start': cursor, 'end': utf16_length(text)})
    return artifact('alignment', audioId=audio_id, textDigest=digest(text), sampleRate=rate, frames=frames, words=words, unmapped=missing, alignerRevision=revision)
