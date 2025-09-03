import { Schema } from 'effect';

// Core AI tool types
export const AIProvider = Schema.Literal('claude', 'gemini', 'codex', 'opencode');
export type AIProvider = Schema.Schema.Type<typeof AIProvider>;

// Unified configuration schema
export const AIToolConfig = Schema.Struct({
  provider: AIProvider,
  model: Schema.optional(Schema.String),
  maxTurns: Schema.optional(Schema.Number),
  systemPrompt: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
});
export type AIToolConfig = Schema.Schema.Type<typeof AIToolConfig>;

// Usage information schema
export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalCost: Schema.optional(Schema.Number),
});
export type Usage = Schema.Schema.Type<typeof Usage>;

// Unified response schema
export const AIResponse = Schema.Struct({
  provider: AIProvider,
  content: Schema.String,
  usage: Schema.optional(Usage),
  sessionId: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type AIResponse = Schema.Schema.Type<typeof AIResponse>;

// Streaming message schema
export const StreamingMessage = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('content'),
    content: Schema.String,
    provider: AIProvider,
  }),
  Schema.Struct({
    type: Schema.Literal('usage'),
    usage: Usage,
  }),
  Schema.Struct({
    type: Schema.Literal('result'),
    response: AIResponse,
  }),
);
export type StreamingMessage = Schema.Schema.Type<typeof StreamingMessage>;
