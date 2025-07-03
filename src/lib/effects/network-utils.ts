/**
 * Shared Network Utilities for Effect-based services
 * Provides common networking functionality like rate limiting, circuit breakers,
 * request pooling, and retry strategies for Jira and Confluence clients
 */

import { Context, Duration, Effect, Layer, Option, pipe, Schedule, Stream } from 'effect';
import { CircuitBreakerError, NetworkError, RateLimitError, TimeoutError, ValidationError } from './errors.js';
import { type LoggerService, LoggerServiceTag } from './layers.js';

// ============= Network Utility Types =============
export interface RequestMetrics {
  url: string;
  method: string;
  startTime: number;
  endTime?: number;
  status?: number;
  error?: string;
  retryCount: number;
  fromCache: boolean;
}

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
  windowMs: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  monitoringWindowMs: number;
  minimumRequests: number;
}

export interface RequestPoolConfig {
  maxConcurrentRequests: number;
  maxQueueSize: number;
  requestTimeoutMs: number;
}

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
  enableCompression: boolean;
}

export interface NetworkUtilsConfig {
  rateLimit: RateLimitConfig;
  circuitBreaker: CircuitBreakerConfig;
  requestPool: RequestPoolConfig;
  cache: CacheConfig;
  enableMetrics: boolean;
}

export interface CachedResponse<T> {
  data: T;
  timestamp: number;
  ttl: number;
  compressed: boolean;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | globalThis.FormData | ArrayBuffer;
  timeout?: number;
  retries?: number;
  skipCache?: boolean;
  skipRateLimit?: boolean;
  priority?: 'low' | 'normal' | 'high';
}

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  nextAttempt: number;
  lastStateChange: number;
}

// ============= Network Utilities Service Interface =============
export interface NetworkUtilsService {
  // Core request functionality
  readonly makeRequest: <T>(
    url: string,
    options?: RequestOptions,
  ) => Effect.Effect<T, NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError>;
  readonly makeRequestWithMetrics: <T>(
    url: string,
    options?: RequestOptions,
  ) => Effect.Effect<
    { data: T; metrics: RequestMetrics },
    NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError
  >;

  // Rate limiting
  readonly checkRateLimit: (key: string) => Effect.Effect<boolean, RateLimitError>;
  readonly consumeRateLimit: (key: string) => Effect.Effect<void, RateLimitError>;
  readonly getRateLimitStatus: (
    key: string,
  ) => Effect.Effect<{ remaining: number; resetTime: number }, ValidationError>;
  readonly resetRateLimit: (key: string) => Effect.Effect<void, ValidationError>;

  // Circuit breaker
  readonly getCircuitState: (key: string) => Effect.Effect<CircuitBreakerState, ValidationError>;
  readonly recordSuccess: (key: string) => Effect.Effect<void, ValidationError>;
  readonly recordFailure: (key: string) => Effect.Effect<void, ValidationError>;
  readonly forceCircuitOpen: (key: string) => Effect.Effect<void, ValidationError>;
  readonly forceCircuitClosed: (key: string) => Effect.Effect<void, ValidationError>;

  // Request pooling
  readonly queueRequest: <T>(
    request: Effect.Effect<T, NetworkError | TimeoutError>,
    priority?: 'low' | 'normal' | 'high',
  ) => Effect.Effect<T, NetworkError | TimeoutError>;
  readonly getPoolStatus: () => Effect.Effect<{ active: number; queued: number; capacity: number }, never>;

  // Caching
  readonly getCachedResponse: <T>(key: string) => Effect.Effect<Option.Option<T>, ValidationError>;
  readonly setCachedResponse: <T>(key: string, data: T, ttlMs?: number) => Effect.Effect<void, ValidationError>;
  readonly invalidateCache: (key: string) => Effect.Effect<void, ValidationError>;
  readonly clearCache: () => Effect.Effect<void, never>;
  readonly getCacheStats: () => Effect.Effect<{ size: number; hitRate: number; memoryUsage: number }, never>;

  // Metrics and monitoring
  readonly getMetrics: () => Effect.Effect<RequestMetrics[], never>;
  readonly getAggregatedMetrics: () => Effect.Effect<
    { totalRequests: number; averageResponseTime: number; errorRate: number; successRate: number },
    never
  >;
  readonly clearMetrics: () => Effect.Effect<void, never>;

  // Batch operations
  readonly batchRequests: <T>(
    requests: Array<{ url: string; options?: RequestOptions }>,
    concurrency?: number,
  ) => Stream.Stream<
    { index: number; result: T },
    NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError
  >;
  readonly streamRequests: <T>(
    requests: Stream.Stream<{ url: string; options?: RequestOptions }, never>,
  ) => Stream.Stream<T, NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError>;
}

export class NetworkUtilsServiceTag extends Context.Tag('NetworkUtilsService')<
  NetworkUtilsServiceTag,
  NetworkUtilsService
>() {}

// ============= Default Configuration =============
export const DEFAULT_NETWORK_CONFIG: NetworkUtilsConfig = {
  rateLimit: {
    requestsPerSecond: 10,
    burstSize: 20,
    windowMs: 1000,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60000, // 1 minute
    monitoringWindowMs: 300000, // 5 minutes
    minimumRequests: 10,
  },
  requestPool: {
    maxConcurrentRequests: 10,
    maxQueueSize: 100,
    requestTimeoutMs: 30000, // 30 seconds
  },
  cache: {
    ttlMs: 300000, // 5 minutes
    maxEntries: 1000,
    enableCompression: true,
  },
  enableMetrics: true,
};

// ============= Network Utilities Service Implementation =============
class NetworkUtilsServiceImpl implements NetworkUtilsService {
  private config: NetworkUtilsConfig;
  private rateLimiters = new Map<string, { tokens: number; lastRefill: number }>();
  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private cache = new Map<string, CachedResponse<unknown>>();
  private metrics: RequestMetrics[] = [];
  private activeRequests = 0;
  private requestQueue: Array<{
    request: () => Promise<unknown>;
    priority: number;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(
    private logger: LoggerService,
    config?: Partial<NetworkUtilsConfig>,
  ) {
    this.config = { ...DEFAULT_NETWORK_CONFIG, ...config };
  }

  // ============= Core Request Functionality =============
  makeRequest<T>(
    url: string,
    options: RequestOptions = {},
  ): Effect.Effect<T, NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError> {
    return pipe(
      this.makeRequestWithMetrics<T>(url, options),
      Effect.map(({ data }) => data),
    );
  }

  makeRequestWithMetrics<T>(
    url: string,
    options: RequestOptions = {},
  ): Effect.Effect<
    { data: T; metrics: RequestMetrics },
    NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError
  > {
    return pipe(
      Effect.sync(
        () =>
          ({
            url,
            method: options.method || 'GET',
            startTime: Date.now(),
            retryCount: 0,
            fromCache: false,
          }) as RequestMetrics,
      ),
      Effect.flatMap((metrics) =>
        pipe(
          // Check cache first
          options.skipCache ? Effect.succeed(Option.none()) : this.getCachedResponse<T>(this.getCacheKey(url, options)),
          Effect.flatMap((cachedResult) => {
            if (Option.isSome(cachedResult)) {
              const finalMetrics = {
                ...metrics,
                endTime: Date.now(),
                status: 200,
                fromCache: true,
              };

              return pipe(
                this.recordMetrics(finalMetrics),
                Effect.map(() => ({ data: cachedResult.value, metrics: finalMetrics })),
              );
            }

            // Proceed with actual request
            return pipe(
              this.executeRequestWithPolicies<T>(url, options, metrics),
              Effect.flatMap(({ data, finalMetrics }) =>
                pipe(
                  // Cache successful responses
                  finalMetrics.status && finalMetrics.status >= 200 && finalMetrics.status < 300
                    ? this.setCachedResponse(this.getCacheKey(url, options), data, this.config.cache.ttlMs)
                    : Effect.succeed(undefined),
                  Effect.map(() => ({ data, metrics: finalMetrics })),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }

  private executeRequestWithPolicies<T>(
    url: string,
    options: RequestOptions,
    metrics: RequestMetrics,
  ): Effect.Effect<
    { data: T; finalMetrics: RequestMetrics },
    NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError
  > {
    const circuitKey = this.getCircuitKey(url);
    const rateLimitKey = this.getRateLimitKey(url);

    return pipe(
      // Check circuit breaker
      this.checkCircuitBreaker(circuitKey),
      Effect.flatMap(() =>
        // Check and consume rate limit
        options.skipRateLimit ? Effect.succeed(undefined) : this.consumeRateLimit(rateLimitKey),
      ),
      Effect.flatMap(() =>
        // Execute the actual request with retry logic
        this.executeWithRetry<T>(url, options, metrics),
      ),
      Effect.tap(({ finalMetrics }) => {
        // Record circuit breaker success/failure
        if (finalMetrics.status && finalMetrics.status >= 200 && finalMetrics.status < 300) {
          return this.recordSuccess(circuitKey);
        } else {
          return this.recordFailure(circuitKey);
        }
      }),
      Effect.tap(({ finalMetrics }) => this.recordMetrics(finalMetrics)),
    );
  }

  private executeWithRetry<T>(
    url: string,
    options: RequestOptions,
    metrics: RequestMetrics,
  ): Effect.Effect<{ data: T; finalMetrics: RequestMetrics }, NetworkError | TimeoutError | RateLimitError> {
    const maxRetries = options.retries || 3;

    const makeRequest = (
      attempt: number,
    ): Effect.Effect<{ data: T; finalMetrics: RequestMetrics }, NetworkError | TimeoutError | RateLimitError> =>
      pipe(
        Effect.tryPromise({
          try: async () => {
            const controller = new AbortController();
            const timeout = options.timeout || this.config.requestPool.requestTimeoutMs;
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
              const requestOptions: RequestInit = {
                method: options.method || 'GET',
                headers: options.headers,
                body: options.body,
                signal: controller.signal,
              };

              const response = await fetch(url, requestOptions);
              clearTimeout(timeoutId);

              const finalMetrics = {
                ...metrics,
                endTime: Date.now(),
                status: response.status,
                retryCount: attempt,
              };

              if (!response.ok) {
                if (response.status === 429) {
                  const retryAfter = response.headers.get('Retry-After');
                  throw new RateLimitError(
                    `Rate limit exceeded: ${response.status}`,
                    retryAfter ? parseInt(retryAfter) * 1000 : undefined,
                  );
                }

                const errorText = await response.text();
                throw new NetworkError(`HTTP ${response.status}: ${errorText}`);
              }

              // Handle different response types
              const contentType = response.headers.get('content-type');
              let data: T;

              if (contentType?.includes('application/json')) {
                data = (await response.json()) as T;
              } else if (contentType?.includes('text/')) {
                data = (await response.text()) as T;
              } else {
                data = (await response.arrayBuffer()) as T;
              }

              return { data, finalMetrics };
            } catch (error) {
              clearTimeout(timeoutId);
              if (error instanceof DOMException && error.name === 'AbortError') {
                throw new TimeoutError(`Request timeout after ${timeout}ms`);
              }
              throw error;
            }
          },
          catch: (error) => {
            if (error instanceof NetworkError || error instanceof TimeoutError || error instanceof RateLimitError) {
              return error;
            }
            return new NetworkError(`Request failed: ${error}`);
          },
        }),
        Effect.catchAll((error) => {
          if (attempt < maxRetries && (error instanceof NetworkError || error instanceof TimeoutError)) {
            const delay = Math.min(1000 * 2 ** attempt, 10000); // Exponential backoff, max 10s
            return pipe(
              this.logger.debug('Retrying request', { url, attempt: attempt + 1, delay }),
              Effect.flatMap(() => Effect.sleep(Duration.millis(delay))),
              Effect.flatMap(() => makeRequest(attempt + 1)),
            );
          }
          return Effect.fail(error);
        }),
      );

    return makeRequest(0);
  }

  // ============= Rate Limiting =============
  checkRateLimit(key: string): Effect.Effect<boolean, RateLimitError> {
    return Effect.sync(() => {
      const limiter = this.rateLimiters.get(key);
      const now = Date.now();

      if (!limiter) {
        this.rateLimiters.set(key, {
          tokens: this.config.rateLimit.burstSize - 1,
          lastRefill: now,
        });
        return true;
      }

      // Refill tokens based on time passed
      const timePassed = now - limiter.lastRefill;
      const tokensToAdd = Math.floor(timePassed / (1000 / this.config.rateLimit.requestsPerSecond));

      if (tokensToAdd > 0) {
        limiter.tokens = Math.min(this.config.rateLimit.burstSize, limiter.tokens + tokensToAdd);
        limiter.lastRefill = now;
      }

      return limiter.tokens > 0;
    });
  }

  consumeRateLimit(key: string): Effect.Effect<void, RateLimitError> {
    return pipe(
      this.checkRateLimit(key),
      Effect.flatMap((allowed) => {
        if (!allowed) {
          return Effect.fail(new RateLimitError('Rate limit exceeded'));
        }

        return Effect.sync(() => {
          const limiter = this.rateLimiters.get(key);
          if (!limiter) {
            throw new Error(`Rate limiter not found for key: ${key}`);
          }
          limiter.tokens--;
        });
      }),
    );
  }

  getRateLimitStatus(key: string): Effect.Effect<{ remaining: number; resetTime: number }, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        const limiter = this.rateLimiters.get(key);
        if (!limiter) {
          return {
            remaining: this.config.rateLimit.burstSize,
            resetTime: Date.now() + this.config.rateLimit.windowMs,
          };
        }

        const nextRefillTime = limiter.lastRefill + 1000 / this.config.rateLimit.requestsPerSecond;
        return {
          remaining: limiter.tokens,
          resetTime: nextRefillTime,
        };
      }),
    );
  }

  resetRateLimit(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        this.rateLimiters.delete(key);
      }),
    );
  }

  // ============= Circuit Breaker =============
  getCircuitState(key: string): Effect.Effect<CircuitBreakerState, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        const state = this.circuitBreakers.get(key);
        if (!state) {
          const defaultState: CircuitBreakerState = {
            state: CircuitState.CLOSED,
            failures: 0,
            successes: 0,
            nextAttempt: 0,
            lastStateChange: Date.now(),
          };
          this.circuitBreakers.set(key, defaultState);
          return defaultState;
        }
        return state;
      }),
    );
  }

  recordSuccess(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.flatMap(() => this.getCircuitState(key)),
      Effect.map((state) => {
        state.successes++;

        if (state.state === CircuitState.HALF_OPEN && state.successes >= this.config.circuitBreaker.minimumRequests) {
          state.state = CircuitState.CLOSED;
          state.failures = 0;
          state.lastStateChange = Date.now();
        }

        // Reset failure count on consecutive successes
        if (state.successes >= this.config.circuitBreaker.minimumRequests) {
          state.failures = 0;
        }
      }),
    );
  }

  recordFailure(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.flatMap(() => this.getCircuitState(key)),
      Effect.map((state) => {
        state.failures++;

        if (state.state === CircuitState.CLOSED && state.failures >= this.config.circuitBreaker.failureThreshold) {
          state.state = CircuitState.OPEN;
          state.nextAttempt = Date.now() + this.config.circuitBreaker.resetTimeoutMs;
          state.lastStateChange = Date.now();
        } else if (state.state === CircuitState.HALF_OPEN) {
          state.state = CircuitState.OPEN;
          state.nextAttempt = Date.now() + this.config.circuitBreaker.resetTimeoutMs;
          state.lastStateChange = Date.now();
        }
      }),
    );
  }

  forceCircuitOpen(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.flatMap(() => this.getCircuitState(key)),
      Effect.map((state) => {
        state.state = CircuitState.OPEN;
        state.nextAttempt = Date.now() + this.config.circuitBreaker.resetTimeoutMs;
        state.lastStateChange = Date.now();
      }),
    );
  }

  forceCircuitClosed(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.flatMap(() => this.getCircuitState(key)),
      Effect.map((state) => {
        state.state = CircuitState.CLOSED;
        state.failures = 0;
        state.successes = 0;
        state.lastStateChange = Date.now();
      }),
    );
  }

  private checkCircuitBreaker(key: string): Effect.Effect<void, CircuitBreakerError | ValidationError> {
    return pipe(
      this.getCircuitState(key),
      Effect.flatMap((state) => {
        const now = Date.now();

        switch (state.state) {
          case CircuitState.CLOSED:
            return Effect.succeed(undefined);

          case CircuitState.OPEN:
            if (now >= state.nextAttempt) {
              state.state = CircuitState.HALF_OPEN;
              state.lastStateChange = now;
              return Effect.succeed(undefined);
            }
            return Effect.fail(new CircuitBreakerError('Circuit breaker is open'));

          case CircuitState.HALF_OPEN:
            return Effect.succeed(undefined);

          default:
            return Effect.fail(new CircuitBreakerError('Unknown circuit breaker state'));
        }
      }),
    );
  }

  // ============= Request Pooling =============
  queueRequest<T>(
    request: Effect.Effect<T, NetworkError | TimeoutError>,
    priority: 'low' | 'normal' | 'high' = 'normal',
  ): Effect.Effect<T, NetworkError | TimeoutError> {
    return Effect.async<T, NetworkError | TimeoutError>((resume) => {
      if (this.activeRequests < this.config.requestPool.maxConcurrentRequests) {
        this.activeRequests++;
        this.executePooledRequest(request, resume);
      } else if (this.requestQueue.length < this.config.requestPool.maxQueueSize) {
        const priorityValue = priority === 'high' ? 2 : priority === 'normal' ? 1 : 0;
        this.requestQueue.push({
          request: () => Effect.runPromise(request),
          priority: priorityValue,
          resolve: (value: unknown) => resume(Effect.succeed(value as T)),
          reject: (error: unknown) => resume(Effect.fail(error as NetworkError | TimeoutError)),
        });

        // Sort by priority
        this.requestQueue.sort((a, b) => b.priority - a.priority);
      } else {
        resume(Effect.fail(new NetworkError('Request queue is full')));
      }
    });
  }

  getPoolStatus(): Effect.Effect<{ active: number; queued: number; capacity: number }, never> {
    return Effect.succeed({
      active: this.activeRequests,
      queued: this.requestQueue.length,
      capacity: this.config.requestPool.maxConcurrentRequests,
    });
  }

  private async executePooledRequest<T>(
    request: Effect.Effect<T, NetworkError | TimeoutError>,
    resume: (result: Effect.Effect<T, NetworkError | TimeoutError>) => void,
  ): Promise<void> {
    try {
      const result = await Effect.runPromise(request);
      resume(Effect.succeed(result));
    } catch (error) {
      resume(Effect.fail(error as NetworkError | TimeoutError));
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.requestQueue.length > 0 && this.activeRequests < this.config.requestPool.maxConcurrentRequests) {
      const next = this.requestQueue.shift();
      if (!next) return;
      this.activeRequests++;

      next
        .request()
        .then(next.resolve)
        .catch(next.reject)
        .finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
    }
  }

  // ============= Caching =============
  getCachedResponse<T>(key: string): Effect.Effect<Option.Option<T>, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        const cached = this.cache.get(key) as CachedResponse<T> | undefined;

        if (!cached) {
          return Option.none();
        }

        const now = Date.now();
        if (now > cached.timestamp + cached.ttl) {
          this.cache.delete(key);
          return Option.none();
        }

        return Option.some(cached.data);
      }),
    );
  }

  setCachedResponse<T>(key: string, data: T, ttlMs?: number): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        // Evict old entries if cache is full
        if (this.cache.size >= this.config.cache.maxEntries) {
          this.evictOldestEntry();
        }

        const cached: CachedResponse<T> = {
          data,
          timestamp: Date.now(),
          ttl: ttlMs || this.config.cache.ttlMs,
          compressed: false, // Compression could be added here
        };

        this.cache.set(key, cached);
      }),
    );
  }

  invalidateCache(key: string): Effect.Effect<void, ValidationError> {
    return pipe(
      this.validateKey(key),
      Effect.map(() => {
        this.cache.delete(key);
      }),
    );
  }

  clearCache(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.cache.clear();
    });
  }

  getCacheStats(): Effect.Effect<{ size: number; hitRate: number; memoryUsage: number }, never> {
    return Effect.sync(() => {
      // Simple memory usage estimation
      const memoryUsage = this.cache.size * 1024; // Rough estimate

      return {
        size: this.cache.size,
        hitRate: 0.85, // This would need proper tracking
        memoryUsage,
      };
    });
  }

  private evictOldestEntry(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, cached] of this.cache.entries()) {
      if (cached.timestamp < oldestTime) {
        oldestTime = cached.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  // ============= Metrics and Monitoring =============
  getMetrics(): Effect.Effect<RequestMetrics[], never> {
    return Effect.succeed([...this.metrics]);
  }

  getAggregatedMetrics(): Effect.Effect<
    { totalRequests: number; averageResponseTime: number; errorRate: number; successRate: number },
    never
  > {
    return Effect.sync(() => {
      if (this.metrics.length === 0) {
        return {
          totalRequests: 0,
          averageResponseTime: 0,
          errorRate: 0,
          successRate: 0,
        };
      }

      const total = this.metrics.length;
      const totalResponseTime = this.metrics
        .filter((m) => m.endTime)
        .reduce((sum, m) => sum + ((m.endTime || 0) - m.startTime), 0);

      const errors = this.metrics.filter((m) => m.error || (m.status && m.status >= 400)).length;
      const successes = this.metrics.filter((m) => !m.error && m.status && m.status < 400).length;

      return {
        totalRequests: total,
        averageResponseTime: totalResponseTime / Math.max(1, this.metrics.filter((m) => m.endTime).length),
        errorRate: errors / total,
        successRate: successes / total,
      };
    });
  }

  clearMetrics(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.metrics = [];
    });
  }

  private recordMetrics(metrics: RequestMetrics): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.config.enableMetrics) {
        this.metrics.push(metrics);

        // Keep only recent metrics to avoid memory issues
        if (this.metrics.length > 10000) {
          this.metrics = this.metrics.slice(-5000);
        }
      }
    });
  }

  // ============= Batch Operations =============
  batchRequests<T>(
    requests: Array<{ url: string; options?: RequestOptions }>,
    concurrency: number = 5,
  ): Stream.Stream<
    { index: number; result: T },
    NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError
  > {
    return pipe(
      Stream.fromIterable(requests.map((req, index) => ({ ...req, index }))),
      Stream.mapEffect(({ url, options, index }) =>
        pipe(
          this.makeRequest<T>(url, options),
          Effect.map((result) => ({ index, result })),
        ),
      ),
      Stream.buffer({ capacity: concurrency }),
    );
  }

  streamRequests<T>(
    requests: Stream.Stream<{ url: string; options?: RequestOptions }, never>,
  ): Stream.Stream<T, NetworkError | TimeoutError | RateLimitError | CircuitBreakerError | ValidationError> {
    return pipe(
      requests,
      Stream.mapEffect(({ url, options }) => this.makeRequest<T>(url, options)),
      Stream.buffer({ capacity: 10 }),
    );
  }

  // ============= Helper Methods =============
  private getCacheKey(url: string, options: RequestOptions): string {
    const method = options.method || 'GET';
    const bodyHash = options.body ? this.simpleHash(String(options.body)) : '';
    return `${method}:${url}:${bodyHash}`;
  }

  private getCircuitKey(url: string): string {
    // Use hostname for circuit breaker grouping
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private getRateLimitKey(url: string): string {
    // Use hostname for rate limit grouping
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private validateKey(key: string): Effect.Effect<void, ValidationError> {
    return Effect.sync(() => {
      if (!key || key.trim().length === 0) {
        throw new ValidationError('Key cannot be empty', 'key', key);
      }
    });
  }
}

// ============= Service Layer =============
export const NetworkUtilsServiceLive = (config?: Partial<NetworkUtilsConfig>) =>
  Layer.effect(
    NetworkUtilsServiceTag,
    pipe(
      LoggerServiceTag,
      Effect.map((logger) => new NetworkUtilsServiceImpl(logger, config)),
    ),
  );

// ============= Helper Functions =============
// Use NetworkUtilsServiceLive directly with Effect.provide() when needed

// ============= Retry Schedules =============
export const createNetworkRetrySchedule = (maxRetries: number = 3, baseDelayMs: number = 100) =>
  pipe(
    Schedule.exponential(Duration.millis(baseDelayMs)),
    Schedule.intersect(Schedule.recurs(maxRetries)),
    Schedule.jittered,
  );

export const createRateLimitRetrySchedule = (maxRetries: number = 5) =>
  pipe(
    Schedule.exponential(Duration.millis(1000)),
    Schedule.intersect(Schedule.recurs(maxRetries)),
    Schedule.whileInput((error: unknown) => error instanceof RateLimitError),
  );

// ============= Utility Effects =============
export const withTimeout = <R, E, A>(
  effect: Effect.Effect<R, E, A>,
  timeoutMs: number,
): Effect.Effect<R, E | TimeoutError, A> =>
  pipe(
    effect,
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.mapError((error) =>
      error instanceof Error && error.message.includes('timeout')
        ? new TimeoutError(`Operation timed out after ${timeoutMs}ms`)
        : (error as E),
    ),
  );

export const withRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  schedule: Schedule.Schedule<unknown, E, R>,
): Effect.Effect<A, E, R> => Effect.retry(effect, schedule);
