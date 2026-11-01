/** All text offsets are UTF-16 code units. All ends are exclusive. */
export interface TextRange { start: number; end: number }
export interface SourceReference extends TextRange { unitId: string; revision: string; block: number }
export interface Artifact { schemaVersion: 1; kind: string; id: string }
export interface ContentChunk extends Artifact {
  kind: 'content'; parentIds: string[]; streamId: string; sequence: number;
  stability: 'draft' | 'sealed'; text: string; paragraphs: TextRange[];
  sourceMap: (TextRange & { identity: boolean; sources: SourceReference[] })[];
}
export interface SpeechChunk extends Artifact {
  kind: 'speech'; parentId: string; sequence: number; text: string; textDigest: string;
  range: TextRange; policy: string;
}
export interface AudioChunk extends Artifact {
  kind: 'audio'; textDigest: string; format: 'pcm_s16le'; sampleRate: 24000; channels: 1;
  frames: number; pcmDigest: string; voiceId: string; referenceId: string;
  modelRevision: string; generationId: string;
}
export interface Alignment extends Artifact {
  kind: 'alignment'; audioId: string; textDigest: string; sampleRate: number; frames: number;
  words: { text: string; startSample: number; endSample: number; range: TextRange | null }[];
  unmapped: TextRange[]; alignerRevision: string;
}
export interface StageResult<T extends Artifact> {
  schemaVersion: 1; stage: 'format' | 'synthesize' | 'align'; status: 'completed' | 'bypassed' | 'rejected';
  inputIds: string[]; output: T; elapsed: number; cached?: boolean;
}
export interface StageContext { signal: AbortSignal; priority: 0 | 1; onStage?: (event: unknown) => void }
export interface ContentTransform { (input: ContentChunk, context: StageContext): Promise<ContentChunk> }
export interface StageFailure { code: string; error: string; stage: string; retryable: boolean }

export interface ReadingUnitInput {
  id?: string; url?: string; streamId?: string; sequence?: number; stability?: 'draft' | 'sealed';
  blocks: string[]; source?: { format?: string }; contentChunks?: ContentChunk[];
  locations?: { unit: string; block: number; offset: number }[]; separators?: string[]; parentIds?: string[];
}
export interface FormatRequest { content: ContentChunk; enabled?: boolean; priority?: 0 | 1 }
export interface SynthesizeRequest { speech: SpeechChunk; voice: string; referenceId: string; language?: string; priority?: 0 | 1 }
export interface AlignRequest { speech: SpeechChunk; audio: AudioChunk; language?: string; priority?: 0 | 1 }
export declare const CONTRACT_VERSION: 1;
export declare class PipelineError extends Error { code: string; stage: string; retryable: boolean; constructor(code: string, message: string, stage?: string, retryable?: boolean) }
export declare function identity(value: unknown): Promise<string>;
export declare function artifact(kind: 'content', body: Omit<ContentChunk, 'schemaVersion' | 'kind' | 'id'>): Promise<ContentChunk>;
export declare function artifact(kind: 'speech', body: Omit<SpeechChunk, 'schemaVersion' | 'kind' | 'id'>): Promise<SpeechChunk>;
export declare function artifact(kind: 'audio', body: Omit<AudioChunk, 'schemaVersion' | 'kind' | 'id'>): Promise<AudioChunk>;
export declare function artifact(kind: 'alignment', body: Omit<Alignment, 'schemaVersion' | 'kind' | 'id'>): Promise<Alignment>;
export declare function parseContent(value: unknown): Promise<ContentChunk>;
export declare function parseSpeech(value: unknown): Promise<SpeechChunk>;
export declare function parseAudio(value: unknown, pcm?: Uint8Array): Promise<AudioChunk>;
export declare function parseAlignment(value: unknown, speech: SpeechChunk, audio: AudioChunk): Promise<Alignment>;
export declare function contentFromUnit(unit: ReadingUnitInput): Promise<ContentChunk>;
export declare function contentChunksFromUnit(unit: ReadingUnitInput): Promise<ContentChunk[]>;
export declare function planSpeech(content: ContentChunk): Promise<SpeechChunk[]>;
export declare function sourceRanges(content: ContentChunk, start: number, end: number): SourceReference[];
export declare function transformContent(content: ContentChunk, record: { original: string; text: string; spans: { start: number; end: number; from: number; to: number; identity: boolean }[] }): Promise<ContentChunk>;
export interface PlayableChunk extends Artifact {
  kind: 'playable'; contentId: string; speechId: string; audioId: string; alignmentId: string;
  sampleRate: number; frames: number;
  words: { text: string; startSample: number; endSample: number; sources: SourceReference[] }[];
}
export declare function projectPlayable(content: ContentChunk, speech: SpeechChunk, audio: AudioChunk, alignment: Alignment): Promise<PlayableChunk>;
export declare function validateContentTransform(input: ContentChunk, output: ContentChunk): Promise<ContentChunk>;
