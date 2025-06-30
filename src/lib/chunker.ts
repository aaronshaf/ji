export interface ChunkResult {
  text: string;
  index: number;
  metadata: {
    startChar: number;
    endChar: number;
    headings?: string[];
    isCode?: boolean;
    codeLanguage?: string;
  };
}

export class DocumentChunker {
  private maxChunkSize: number;
  private overlap: number;

  constructor(maxChunkSize: number = 500, overlap: number = 50) {
    this.maxChunkSize = maxChunkSize;
    this.overlap = overlap;
  }

  chunk(text: string): ChunkResult[] {
    if (!text || text.length <= this.maxChunkSize) {
      return [{
        text: text,
        index: 0,
        metadata: {
          startChar: 0,
          endChar: text.length
        }
      }];
    }

    const chunks: ChunkResult[] = [];
    
    // Try to chunk by paragraphs first
    const paragraphs = this.splitByParagraphs(text);
    let currentChunk = '';
    let currentStart = 0;
    let chunkIndex = 0;

    for (const para of paragraphs) {
      // If adding this paragraph would exceed max size
      if (currentChunk.length + para.text.length > this.maxChunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          text: currentChunk.trim(),
          index: chunkIndex++,
          metadata: {
            startChar: currentStart,
            endChar: para.startChar - 1
          }
        });

        // Start new chunk with overlap
        const overlapText = this.getOverlapText(currentChunk, this.overlap);
        currentChunk = overlapText + para.text;
        currentStart = para.startChar - overlapText.length;
      } else {
        currentChunk += para.text;
        if (chunks.length === 0) {
          currentStart = para.startChar;
        }
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        index: chunkIndex,
        metadata: {
          startChar: currentStart,
          endChar: text.length
        }
      });
    }

    return chunks;
  }

  chunkCode(code: string, language?: string): ChunkResult[] {
    // For code, try to chunk by functions/classes if possible
    const lines = code.split('\n');
    const chunks: ChunkResult[] = [];
    let currentChunk: string[] = [];
    let currentStart = 0;
    let chunkIndex = 0;
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Simple heuristic: new function/class starts
      const isNewBlock = /^(function|class|def|export|public|private|protected)\s/.test(line.trim());
      
      if (isNewBlock && currentChunk.length > 0 && currentChunk.join('\n').length > this.maxChunkSize / 2) {
        // Save current chunk
        chunks.push({
          text: currentChunk.join('\n'),
          index: chunkIndex++,
          metadata: {
            startChar: currentStart,
            endChar: charCount - 1,
            isCode: true,
            codeLanguage: language
          }
        });
        
        currentChunk = [line];
        currentStart = charCount;
      } else {
        currentChunk.push(line);
      }
      
      charCount += line.length + 1; // +1 for newline
    }

    // Last chunk
    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.join('\n'),
        index: chunkIndex,
        metadata: {
          startChar: currentStart,
          endChar: charCount - 1,
          isCode: true,
          codeLanguage: language
        }
      });
    }

    return chunks;
  }

  private splitByParagraphs(text: string): Array<{text: string, startChar: number}> {
    const paragraphs: Array<{text: string, startChar: number}> = [];
    const regex = /\n\n+/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      paragraphs.push({
        text: text.substring(lastIndex, match.index) + '\n\n',
        startChar: lastIndex
      });
      lastIndex = regex.lastIndex;
    }

    // Don't forget the last paragraph
    if (lastIndex < text.length) {
      paragraphs.push({
        text: text.substring(lastIndex),
        startChar: lastIndex
      });
    }

    // If no paragraphs found, split by sentences
    if (paragraphs.length === 1) {
      return this.splitBySentences(text);
    }

    return paragraphs;
  }

  private splitBySentences(text: string): Array<{text: string, startChar: number}> {
    const sentences: Array<{text: string, startChar: number}> = [];
    const regex = /[.!?]+\s+/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      sentences.push({
        text: text.substring(lastIndex, regex.lastIndex),
        startChar: lastIndex
      });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      sentences.push({
        text: text.substring(lastIndex),
        startChar: lastIndex
      });
    }

    return sentences;
  }

  private getOverlapText(text: string, overlapSize: number): string {
    const words = text.split(/\s+/);
    const overlapWords = Math.ceil(overlapSize / 5); // Rough estimate: 5 chars per word
    return words.slice(-overlapWords).join(' ') + ' ';
  }
}