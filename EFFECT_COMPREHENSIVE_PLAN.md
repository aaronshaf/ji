# Comprehensive Effect Integration Plan

## Overview
This plan outlines the next phase of Effect integration, focusing on:
1. **Splitting cli.ts into smaller, manageable files (HIGHEST PRIORITY)**
2. Replacing Zod with @effect/schema throughout the codebase
3. Migrating remaining Promise-based code to Effect
4. Implementing advanced Effect patterns and features
5. Achieving 100% Effect-based architecture

## Phase 0: Split cli.ts (IMMEDIATE - Week 1)

### 0.1 Current State Analysis
The cli.ts file is 3688 lines - far too large for maintainability. It contains:
- Command handlers
- Formatting functions
- Business logic
- UI components
- Sync operations

### 0.2 Proposed File Structure
```
src/
├── cli/
│   ├── index.ts                 # Main CLI entry point (50-100 lines)
│   ├── commands/
│   │   ├── issue.ts            # Issue-related commands
│   │   ├── board.ts            # Board-related commands
│   │   ├── sprint.ts           # Sprint-related commands
│   │   ├── sync.ts             # Sync commands
│   │   ├── config.ts           # Config commands
│   │   ├── ask.ts              # AI ask command
│   │   └── mine.ts             # Mine command
│   ├── formatters/
│   │   ├── issue.ts            # Issue formatting functions
│   │   ├── board.ts            # Board formatting
│   │   ├── sprint.ts           # Sprint formatting
│   │   └── table.ts            # Table formatting utilities
│   ├── sync/
│   │   ├── boards.ts           # Board sync operations
│   │   ├── issues.ts           # Issue sync operations
│   │   ├── confluence.ts       # Confluence sync operations
│   │   └── orchestrator.ts     # Sync orchestration
│   └── utils/
│       ├── spinners.ts         # Spinner utilities
│       ├── prompts.ts          # User prompt utilities
│       └── validation.ts       # CLI argument validation
```

### 0.3 Migration Strategy

#### Step 1: Create new directory structure
```bash
mkdir -p src/cli/{commands,formatters,sync,utils}
```

#### Step 2: Extract formatters (easiest, no side effects)
```typescript
// src/cli/formatters/issue.ts
export function formatIssue(issue: Issue, options?: FormatOptions): string {
  // Move formatting logic here
}

export function formatIssueTable(issues: Issue[]): string {
  // Move table formatting here
}
```

#### Step 3: Extract command handlers
```typescript
// src/cli/commands/issue.ts
import { Effect, pipe } from "effect"
import { JiraClientService } from "../../lib/effects/jira-client-service"
import { formatIssue } from "../formatters/issue"

export const handleIssueCommand = (args: string[]) =>
  pipe(
    parseIssueArgs(args),
    Effect.flatMap(({ issueKey }) => 
      JiraClientService.getIssue(issueKey)
    ),
    Effect.map(formatIssue),
    Effect.tap(Console.log)
  )
```

#### Step 4: Create unified CLI entry point
```typescript
// src/cli/index.ts
import { Effect, pipe } from "effect"
import * as IssueCommands from "./commands/issue"
import * as BoardCommands from "./commands/board"
// ... other imports

const commandMap = {
  issue: IssueCommands.handleIssueCommand,
  board: BoardCommands.handleBoardCommand,
  // ... etc
}

export const runCLI = (args: string[]) =>
  pipe(
    parseCommand(args),
    Effect.flatMap(({ command, args }) => {
      const handler = commandMap[command]
      if (!handler) {
        return Effect.fail(new UnknownCommandError(command))
      }
      return handler(args)
    }),
    Effect.provide(AppLayer),
    Effect.catchAll(handleError)
  )
```

### 0.4 Benefits of Splitting
1. **Maintainability**: Each file has a single responsibility
2. **Testability**: Individual components can be tested in isolation
3. **Reusability**: Formatters and utilities can be reused
4. **Type Safety**: Smaller files make type inference faster
5. **Effect Integration**: Easier to convert smaller files to Effect

## Phase 1: @effect/schema Migration (Week 1-2)

### 1.1 Install @effect/schema
```bash
bun add @effect/schema
```

### 1.2 Replace Zod Schemas

#### Jira Schemas (src/lib/effects/jira-client-service.ts)
```typescript
import { Schema } from "@effect/schema"

// Replace Zod schemas with @effect/schema
const IssueSchema = Schema.struct({
  key: Schema.string,
  self: Schema.string,
  fields: Schema.struct({
    summary: Schema.string,
    description: Schema.nullable(Schema.string),
    status: Schema.struct({
      name: Schema.string,
    }),
    assignee: Schema.nullable(Schema.struct({
      displayName: Schema.string,
      emailAddress: Schema.optional(Schema.string.pipe(Schema.email)),
      accountId: Schema.string,
    })),
    reporter: Schema.struct({
      displayName: Schema.string,
      emailAddress: Schema.optional(Schema.string.pipe(Schema.email)),
      accountId: Schema.string,
    }),
    priority: Schema.nullable(Schema.struct({
      name: Schema.string,
    })),
    project: Schema.optional(Schema.struct({
      key: Schema.string,
      name: Schema.string,
    })),
    created: Schema.string,
    updated: Schema.string,
    // Custom fields with unknown types
    customfield_10020: Schema.optional(Schema.unknown),
    customfield_10021: Schema.optional(Schema.unknown),
    // ... etc
  }).pipe(Schema.record(Schema.string, Schema.unknown)), // catchall
})

// Type inference
type Issue = Schema.Schema.To<typeof IssueSchema>
```

#### Confluence Schemas (src/lib/effects/confluence-client-service.ts)
```typescript
const PageSchema = Schema.struct({
  id: Schema.string,
  type: Schema.string,
  status: Schema.string,
  title: Schema.string,
  space: Schema.struct({
    key: Schema.string,
    name: Schema.string,
    id: Schema.optional(Schema.string),
    type: Schema.optional(Schema.string),
  }),
  version: Schema.struct({
    number: Schema.number,
    when: Schema.string,
    by: Schema.optional(Schema.struct({
      displayName: Schema.string,
      userKey: Schema.optional(Schema.string),
      accountId: Schema.optional(Schema.string),
    })),
    message: Schema.optional(Schema.string),
  }),
  body: Schema.optional(Schema.struct({
    storage: Schema.optional(Schema.struct({
      value: Schema.string,
      representation: Schema.literal('storage'),
    })),
    view: Schema.optional(Schema.struct({
      value: Schema.string,
      representation: Schema.literal('view'),
    })),
    atlas_doc_format: Schema.optional(Schema.struct({
      value: Schema.string,
      representation: Schema.literal('atlas_doc_format'),
    })),
  })),
  _links: Schema.struct({
    self: Schema.string,
    webui: Schema.string,
    base: Schema.optional(Schema.string),
  }),
  ancestors: Schema.optional(Schema.array(Schema.struct({
    id: Schema.string,
    title: Schema.string,
  }))),
})
```

#### Configuration Schemas (src/lib/config.ts)
```typescript
const ConfigSchema = Schema.struct({
  jiraUrl: Schema.string,
  jiraEmail: Schema.string,
  jiraApiToken: Schema.string,
  confluenceUrl: Schema.optional(Schema.string),
  confluenceEmail: Schema.optional(Schema.string),
  confluenceApiToken: Schema.optional(Schema.string),
  currentProjectKey: Schema.optional(Schema.string),
  currentBoardId: Schema.optional(Schema.number),
  aiProvider: Schema.optional(Schema.literal('ollama', 'openai')),
  ollamaBaseUrl: Schema.optional(Schema.string),
  openaiApiKey: Schema.optional(Schema.string),
  defaultAiModel: Schema.optional(Schema.string),
})
```

### 1.3 Update Parsing Logic
Replace Zod parsing with @effect/schema:
```typescript
// Old (Zod)
const result = IssueSchema.parse(data)

// New (@effect/schema)
import { Schema } from "@effect/schema"

const parseIssue = Schema.decodeUnknown(IssueSchema)

// In Effect pipeline
Effect.flatMap((data) => 
  parseIssue(data).pipe(
    Effect.mapError((error) => 
      new ParseError('Failed to parse issue', 'issue', data, error)
    )
  )
)
```

## Phase 2: Complete CLI Migration (Week 2-3)

### 2.1 Convert CLI Commands to Effect
Transform all commands in src/cli.ts to use Effect:

```typescript
// Old
async function handleIssueCommand(args: string[]) {
  try {
    const issue = await jiraClient.getIssue(issueKey);
    console.log(formatIssue(issue));
  } catch (error) {
    console.error('Error:', error);
  }
}

// New
const handleIssueCommand = (args: string[]) =>
  pipe(
    parseIssueArgs(args),
    Effect.flatMap(({ issueKey }) => 
      JiraClientService.getIssue(issueKey)
    ),
    Effect.map(formatIssue),
    Effect.tap((formatted) => Console.log(formatted)),
    Effect.catchAll((error) => 
      Console.error(`Error: ${error.message}`)
    )
  )
```

### 2.2 Implement Effect-based CLI Runner
```typescript
const runCLI = (args: string[]) =>
  pipe(
    parseCommand(args),
    Effect.flatMap((command) => {
      switch (command.type) {
        case 'issue': return handleIssueCommand(command.args)
        case 'board': return handleBoardCommand(command.args)
        case 'sync': return handleSyncCommand(command.args)
        // ... etc
      }
    }),
    Effect.provide(LiveEnvironment),
    Effect.runPromise
  )
```

## Phase 3: Advanced Effect Patterns (Week 3-4)

### 3.1 Implement Streaming for Large Data
```typescript
// Stream all issues with pagination
const streamAllIssues = (projectKey: string) =>
  Stream.paginateChunkEffect(
    { startAt: 0 },
    ({ startAt }) =>
      pipe(
        searchIssues(`project = ${projectKey}`, { startAt, maxResults: 100 }),
        Effect.map((result) => [
          Chunk.fromIterable(result.issues),
          result.isLast ? Option.none() : Option.some({ startAt: startAt + 100 })
        ])
      )
  )
```

### 3.2 Add Concurrency Control
```typescript
// Process issues with controlled concurrency
const processIssuesWithConcurrency = (issues: Stream.Stream<Issue>) =>
  pipe(
    issues,
    Stream.mapEffect(
      (issue) => processIssue(issue),
      { concurrency: "inherit", unordered: true }
    ),
    Stream.runDrain
  )
```

### 3.3 Implement Resource Management
```typescript
// Database connection pool
const DatabasePoolLive = Layer.scoped(
  DatabasePoolTag,
  Effect.acquireRelease(
    pipe(
      Config.get("DATABASE_URL"),
      Effect.flatMap(createDatabasePool),
      Effect.tap(() => Console.log("Database pool created"))
    ),
    (pool) => 
      pipe(
        Effect.sync(() => pool.close()),
        Effect.tap(() => Console.log("Database pool closed"))
      )
  )
)
```

### 3.4 Add Ref for State Management
```typescript
// Cache with Ref
interface CacheState {
  entries: Map<string, CachedEntry>
  stats: CacheStats
}

const createCache = () =>
  Ref.make<CacheState>({
    entries: new Map(),
    stats: { hits: 0, misses: 0, evictions: 0 }
  })

const getCached = <T>(key: string, cache: Ref.Ref<CacheState>) =>
  pipe(
    Ref.get(cache),
    Effect.flatMap((state) => {
      const entry = state.entries.get(key)
      if (entry && !isExpired(entry)) {
        return pipe(
          Ref.update(cache, updateStats('hit')),
          Effect.as(Option.some(entry.value as T))
        )
      }
      return pipe(
        Ref.update(cache, updateStats('miss')),
        Effect.as(Option.none())
      )
    })
  )
```

## Phase 4: Effect Platform Integration (Week 4-5)

### 4.1 Replace HTTP Client
```typescript
import { HttpClient } from "@effect/platform"

const JiraHttpClient = HttpClient.HttpClient.pipe(
  HttpClient.mapRequest(HttpClient.prependUrl(jiraUrl)),
  HttpClient.mapRequest(addAuthHeaders),
  HttpClient.retry(Schedule.exponential(100)),
  HttpClient.timeout(Duration.seconds(30))
)
```

### 4.2 Add Metrics and Tracing
```typescript
import { Metric } from "effect"

const requestCounter = Metric.counter("jira_requests_total")
const requestDuration = Metric.histogram("jira_request_duration_ms")

const instrumentedRequest = <T>(request: Effect.Effect<T, E, R>) =>
  pipe(
    Effect.Do,
    Effect.bind("start", () => Clock.currentTimeMillis),
    Effect.bind("result", () => 
      request.pipe(
        Effect.tap(() => requestCounter.increment()),
        Effect.tapError(() => requestCounter.increment({ status: "error" }))
      )
    ),
    Effect.bind("end", () => Clock.currentTimeMillis),
    Effect.tap(({ start, end }) => 
      requestDuration.observe(end - start)
    ),
    Effect.map(({ result }) => result)
  )
```

### 4.3 Implement Background Jobs with Fiber
```typescript
const backgroundSync = () =>
  pipe(
    Effect.forever(
      pipe(
        syncAllData(),
        Effect.delay(Duration.minutes(5))
      )
    ),
    Effect.forkDaemon,
    Effect.map((fiber) => ({
      cancel: () => Fiber.interrupt(fiber)
    }))
  )
```

## Phase 5: Testing Infrastructure (Week 5-6)

### 5.1 Effect Test Utilities
```typescript
import { TestEnvironment } from "@effect/vitest"

describe("JiraClientService", () => {
  it.effect("should fetch issue", () =>
    Effect.gen(function* (_) {
      const issue = yield* _(JiraClientService.getIssue("TEST-123"))
      expect(issue.key).toBe("TEST-123")
    }).pipe(
      Effect.provide(TestJiraClientService),
      Effect.provide(TestEnvironment)
    )
  )
})
```

### 5.2 Property-Based Testing
```typescript
import { FastCheck } from "@effect/schema/FastCheck"

const issueArbitrary = FastCheck.make(IssueSchema)

test.prop([issueArbitrary])("issue serialization", (issue) =>
  Effect.gen(function* (_) {
    const serialized = yield* _(serialize(issue))
    const deserialized = yield* _(deserialize(serialized))
    expect(deserialized).toEqual(issue)
  })
)
```

## Phase 6: Complete Service Architecture (Week 6)

### 6.1 Unified Service Layer
```typescript
// All services composed
const AppLayer = Layer.mergeAll(
  ConfigServiceLive,
  LoggerServiceLive,
  DatabaseServiceLive,
  HttpClientServiceLive,
  CacheServiceLive,
  SchemaServiceLive,
  JiraClientServiceLive,
  ConfluenceClientServiceLive,
  ContentServiceLive,
  SearchServiceLive,
  AIServiceLive,
  MetricsServiceLive
)

// Run application
const program = pipe(
  initializeApp(),
  Effect.flatMap(() => runCLI(process.argv.slice(2))),
  Effect.provide(AppLayer)
)

Effect.runPromise(program)
```

## Migration Checklist

### Files to Migrate to @effect/schema:
- [ ] src/lib/config.ts - Replace Zod with @effect/schema
- [ ] src/lib/effects/jira-client-service.ts - Update all schemas
- [ ] src/lib/effects/confluence-client-service.ts - Update all schemas
- [ ] src/lib/effects/content-service.ts - Add schemas for content types
- [ ] src/lib/cache.ts - Add schemas for cache entries
- [ ] src/lib/memory.ts - Add schemas for memory entries

### Files to Convert to Effect:
- [ ] src/cli.ts - Full Effect conversion (3688 lines)
- [ ] src/lib/confluence-client.ts - Migrate to Effect
- [ ] src/lib/jira-client.ts - Migrate to Effect
- [ ] src/lib/confluence-converter.ts - Use Effect streams
- [ ] src/lib/cache.ts - Convert to Effect with Ref
- [ ] src/lib/memory.ts - Convert to Effect with Ref
- [ ] src/lib/content-manager.ts - Full Effect conversion
- [ ] src/lib/ollama.ts - Effect-based AI service
- [ ] All sync-*.ts files - Convert to Effect

### New Features to Add:
- [ ] Request queue with Semaphore for rate limiting
- [ ] Circuit breaker with Ref state
- [ ] Background sync with Fiber
- [ ] Metrics collection and export
- [ ] Structured logging with context
- [ ] Resource pooling for database
- [ ] Streaming for large data operations
- [ ] Property-based testing
- [ ] Effect-based CLI framework

## Benefits of Full Effect Integration

1. **Type Safety**: @effect/schema provides better type inference and validation
2. **Error Handling**: Comprehensive error tracking and recovery
3. **Concurrency**: Built-in primitives for safe concurrent operations
4. **Resource Safety**: Automatic cleanup with acquireRelease
5. **Observability**: Built-in metrics, tracing, and logging
6. **Testing**: Powerful testing utilities and property-based testing
7. **Performance**: Streaming and lazy evaluation for large datasets
8. **Composability**: Services compose naturally with layers

## Implementation Priority

1. **Critical** (Week 1-2):
   - Replace Zod with @effect/schema
   - Complete CLI migration
   - Fix remaining Promise-based code

2. **Important** (Week 3-4):
   - Add streaming for large operations
   - Implement proper caching with Ref
   - Add concurrency control

3. **Enhancement** (Week 5-6):
   - Metrics and monitoring
   - Background jobs with Fiber
   - Advanced testing infrastructure

This comprehensive plan will transform the ji codebase into a fully Effect-based application, leveraging all the power and safety that Effect provides.