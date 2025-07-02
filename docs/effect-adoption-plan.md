# Effect Incremental Adoption Plan for ji CLI

## Phase 1: Start at the Edges (Week 1-2)

### 1.1 Pure Utility Functions
Start with functions that have no side effects and clear inputs/outputs:

- [x] `OllamaClient.contentHash()` - Already implemented
- [x] `hashQuestion()` in memory.ts
- [x] `containsUncertainty()` in memory.ts
- [x] `confluenceToMarkdown()` in confluence-converter.ts

### 1.2 New Features
Any new features should be built with Effect from the start:
- New commands
- New API integrations
- New data transformations

## Phase 2: Boundary Pattern (Week 3-4)

### 2.1 External Service Adapters
Create Effect wrappers for external services:

```typescript
// src/lib/effects/jira-effect.ts
import { Effect, pipe } from 'effect'
import { JiraClient } from '../jira-client'

export class JiraEffectClient {
  constructor(private client: JiraClient) {}

  getIssue(key: string): Effect.Effect<Issue, JiraError> {
    return Effect.tryPromise({
      try: () => this.client.getIssue(key),
      catch: (error) => new JiraError(`Failed to get issue ${key}`, error)
    })
  }

  searchIssues(jql: string): Effect.Effect<Issue[], JiraError> {
    return Effect.tryPromise({
      try: () => this.client.searchIssues(jql),
      catch: (error) => new JiraError(`Search failed: ${jql}`, error)
    })
  }
}
```

### 2.2 Database Adapters
Wrap SQLite operations:

```typescript
// src/lib/effects/cache-effect.ts
export class CacheEffect {
  constructor(private cache: CacheManager) {}

  getIssue(key: string): Effect.Effect<Issue, DatabaseError | ParseError> {
    return pipe(
      Effect.sync(() => this.cache.db.prepare('SELECT raw_data FROM issues WHERE key = ?')),
      Effect.map(stmt => stmt.get(key) as { raw_data: string } | undefined),
      Effect.filterOrFail(
        row => row !== undefined,
        () => new DatabaseError(`Issue ${key} not found`)
      ),
      Effect.flatMap(row =>
        Effect.try({
          try: () => JSON.parse(row.raw_data) as Issue,
          catch: (e) => new ParseError(`Failed to parse issue ${key}`, e)
        })
      )
    )
  }
}
```

## Phase 3: Module-by-Module Migration (Week 5-8)

### 3.1 Configuration Module
The config module is a perfect candidate - it's self-contained and critical:

```typescript
// src/lib/effects/config-effect.ts
import { Effect, Option } from 'effect'

export interface ConfigService {
  readonly getConfig: Effect.Effect<Config, ConfigError>
  readonly getSetting: (key: string) => Effect.Effect<Option.Option<string>, DatabaseError>
  readonly setSetting: (key: string, value: string) => Effect.Effect<void, DatabaseError>
}

// Implementation with proper error types and validation
```

### 3.2 Ollama Module
Convert the entire Ollama integration:

```typescript
// src/lib/effects/ollama-effect.ts
export interface OllamaService {
  readonly isAvailable: Effect.Effect<boolean, NetworkError>
  readonly generate: (prompt: string) => Effect.Effect<string, OllamaError>
  readonly embed: (text: string) => Effect.Effect<number[], OllamaError>
}
```

## Phase 4: Gradual Type System Integration (Ongoing)

### 4.1 Error Hierarchy
Build a proper error hierarchy:

```typescript
// src/lib/effects/errors.ts
export class JiError extends Error {
  readonly _tag: string
}

export class NetworkError extends JiError {
  readonly _tag = 'NetworkError'
}

export class DatabaseError extends JiError {
  readonly _tag = 'DatabaseError'
}

export class ValidationError extends JiError {
  readonly _tag = 'ValidationError'
}

export class ConfigError extends JiError {
  readonly _tag = 'ConfigError'
}
```

### 4.2 Context/Services (Later)
Once comfortable with basic Effect:

```typescript
// src/lib/effects/context.ts
export interface AppConfig {
  readonly jiraUrl: string
  readonly confluenceUrl: string
}

export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  AppConfig
>() {}

// Use in effects
const program = Effect.gen(function* () {
  const config = yield* AppConfig
  // Use config...
})
```

## Migration Guidelines

### DO:
- Keep existing APIs working with adapter functions
- Test Effect and non-Effect versions side-by-side
- Document Effect patterns for the team
- Use Effect for all new code

### DON'T:
- Mix Effect and Promise code in the same function
- Force Effect into places where it doesn't add value
- Convert everything at once
- Skip error typing

## Success Metrics
- Reduced runtime errors
- Better error messages in logs
- Easier testing of edge cases
- More composable code
- Team comfort with Effect patterns

## Example: Complete Module Migration

Here's how to migrate the memory module:

```typescript
// src/lib/effects/memory-effect.ts
import { Effect, Option, pipe } from 'effect'
import { Database } from 'bun:sqlite'

export class MemoryService {
  constructor(private db: Database) {}

  findSimilarMemory(questionHash: string): Effect.Effect<Option.Option<Memory>, DatabaseError> {
    return Effect.try({
      try: () => {
        const stmt = this.db.prepare(`
          SELECT * FROM ask_memory 
          WHERE question_hash = ? 
          ORDER BY created_at DESC 
          LIMIT 1
        `)
        const result = stmt.get(questionHash) as Memory | undefined
        return Option.fromNullable(result)
      },
      catch: (e) => new DatabaseError('Failed to find memory', e)
    })
  }

  saveMemory(memory: Memory): Effect.Effect<void, DatabaseError> {
    return Effect.try({
      try: () => {
        const stmt = this.db.prepare(`
          INSERT INTO ask_memory (id, question_hash, question, answer, facts, sources, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
          memory.id,
          memory.question_hash,
          memory.question,
          memory.answer,
          memory.facts,
          JSON.stringify(memory.sources),
          memory.created_at
        )
      },
      catch: (e) => new DatabaseError('Failed to save memory', e)
    })
  }
}
```

This incremental approach lets us gain Effect's benefits without disrupting the entire codebase.