/** Adapter-local geometry stays in Chrome. Only text/source references enter the model pipeline. */
export interface WordPosition { block: number; start: number; end: number }
export interface SourceSnapshot {
  id: string; title: string; url: string; language?: string; label?: string;
  blocks: { text: string; [privateGeometry: string]: unknown }[];
}
export interface SourceCapabilities {
  format: 'dom' | 'ocr' | 'captions'; pagination: boolean; prefetch: boolean; scroll?: boolean;
  preparationNotice?: string;
}
export interface SourceAdapter {
  id: string; capabilities: SourceCapabilities;
  open(): Promise<SourceSnapshot>;
  current(): SourceSnapshot | null;
  has(id: string): boolean;
  prepareNext(after: string, count: number): Promise<SourceSnapshot[]>;
  present(id: string): Promise<SourceSnapshot>;
  span(block: number, start: number, end: number): unknown;
  wordAtPoint(x: number, y: number): WordPosition | null;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
