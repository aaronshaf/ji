/**
 * Confluence Client Service Implementation
 * Main implementation class that combines all operation modules
 */

import { Effect, type Option, pipe, Stream } from 'effect';
import type { ConfigError, NetworkError, NotFoundError, ValidationError } from '../errors.js';
import type { ConfigService, HttpClientService, LoggerService } from '../layers.js';
import { AttachmentOperations } from './attachment-operations.js';
import { BatchOperations } from './batch-operations.js';
import { ContentOperations } from './content-operations.js';
import type { ConfluenceClientService } from './interface.js';
import type { Attachment, Page, Space } from './schemas.js';
import { SearchOperations } from './search-operations.js';
import { SpaceOperations } from './space-operations.js';
import type {
  AllErrors,
  CommonErrors,
  ContentCreationOptions,
  ContentUpdateOptions,
  PageSearchResult,
  PageSummary,
  SearchOptions,
  SpaceContentOptions,
  SpaceSearchResult,
} from './types.js';

export class ConfluenceClientServiceImpl implements ConfluenceClientService {
  private baseUrl: string = '';
  private spaceOps!: SpaceOperations;
  private contentOps!: ContentOperations;
  private searchOps!: SearchOperations;
  private attachmentOps!: AttachmentOperations;
  private batchOps!: BatchOperations;
  private initialized = false;

  constructor(
    private http: HttpClientService,
    private config: ConfigService,
    private logger: LoggerService,
  ) {}

  private initializeOperations(): Effect.Effect<void, NetworkError | ConfigError> {
    if (this.initialized) {
      return Effect.succeed(undefined);
    }

    return pipe(
      this.config.getConfig,
      Effect.map((config) => {
        this.baseUrl = `${config.jiraUrl}/wiki/rest/api`;

        // Initialize all operation modules
        this.spaceOps = new SpaceOperations(this.http, this.config, this.logger, this.baseUrl);
        this.searchOps = new SearchOperations(this.http, this.config, this.logger, this.baseUrl);
        this.contentOps = new ContentOperations(
          this.http,
          this.config,
          this.logger,
          this.baseUrl,
          this.searchContent.bind(this),
        );
        this.attachmentOps = new AttachmentOperations(this.http, this.config, this.logger, this.baseUrl);
        this.batchOps = new BatchOperations(this.logger, this.getPage.bind(this), this.updatePage.bind(this));

        this.initialized = true;
      }),
    );
  }

  // ============= Space Operations =============
  getSpace(spaceKey: string): Effect.Effect<Space, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.spaceOps.getSpace(spaceKey)),
    );
  }

  getAllSpaces(options?: SearchOptions): Effect.Effect<SpaceSearchResult, CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.spaceOps.getAllSpaces(options)),
    );
  }

  getSpacePermissions(
    spaceKey: string,
  ): Effect.Effect<
    ReadonlyArray<{ operation: string; targetType: string }> | Array<{ operation: string; targetType: string }>,
    ValidationError | NotFoundError | CommonErrors
  > {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.spaceOps.getSpacePermissions(spaceKey)),
    );
  }

  validateSpaceAccess(spaceKey: string): Effect.Effect<boolean, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.spaceOps.validateSpaceAccess(spaceKey)),
    );
  }

  getSpaceAnalytics(
    spaceKey: string,
  ): Effect.Effect<
    { pageCount: number; recentActivity: number; lastModified?: Date },
    ValidationError | CommonErrors | NotFoundError
  > {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() =>
        this.spaceOps.getSpaceAnalytics(
          spaceKey,
          this.getSpaceContent.bind(this),
          this.getRecentlyUpdatedPages.bind(this),
        ),
      ),
    );
  }

  // ============= Content Operations =============
  getPage(pageId: string, expand?: string[]): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.getPage(pageId, expand)),
    );
  }

  getPageByTitle(
    spaceKey: string,
    title: string,
  ): Effect.Effect<Option.Option<Page>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.getPageByTitle(spaceKey, title)),
    );
  }

  getSpaceContent(
    spaceKey: string,
    options?: SpaceContentOptions,
  ): Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.getSpaceContent(spaceKey, options)),
    );
  }

  getAllSpacePages(spaceKey: string): Stream.Stream<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.initializeOperations()),
      Stream.flatMap(() => this.contentOps.getAllSpacePages(spaceKey)),
    );
  }

  getChildPages(pageId: string, expand?: string[]): Effect.Effect<readonly Page[] | Page[], AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.getChildPages(pageId, expand)),
    );
  }

  getPageAncestors(
    pageId: string,
  ): Effect.Effect<ReadonlyArray<{ id: string; title: string }> | Array<{ id: string; title: string }>, AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.getPageAncestors(pageId)),
    );
  }

  createPage(options: ContentCreationOptions): Effect.Effect<Page, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.createPage(options)),
    );
  }

  updatePage(pageId: string, options: ContentUpdateOptions): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.updatePage(pageId, options)),
    );
  }

  deletePage(pageId: string): Effect.Effect<void, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.deletePage(pageId)),
    );
  }

  movePage(pageId: string, targetSpaceKey: string, targetParentId?: string): Effect.Effect<Page, AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.contentOps.movePage(pageId, targetSpaceKey, targetParentId)),
    );
  }

  // ============= Search Operations =============
  searchContent(
    cql: string,
    options?: SearchOptions,
  ): Effect.Effect<Array<PageSummary>, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.searchOps.searchContent(cql, options)),
    );
  }

  getRecentlyUpdatedPages(
    spaceKey: string,
    limit?: number,
  ): Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.searchOps.getRecentlyUpdatedPages(spaceKey, limit)),
    );
  }

  getPagesSince(
    spaceKey: string,
    sinceDate: Date,
  ): Stream.Stream<string, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.initializeOperations()),
      Stream.flatMap(() => this.searchOps.getPagesSince(spaceKey, sinceDate)),
    );
  }

  getSpacePagesLightweight(
    spaceKey: string,
  ): Stream.Stream<PageSummary, ValidationError | CommonErrors | NotFoundError> {
    return pipe(
      Stream.fromEffect(this.initializeOperations()),
      Stream.flatMap(() => this.searchOps.getSpacePagesLightweight(spaceKey, this.getSpaceContent.bind(this))),
    );
  }

  // ============= Attachment Operations =============
  getPageAttachments(pageId: string): Effect.Effect<Attachment[], AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.attachmentOps.getPageAttachments(pageId)),
    );
  }

  downloadAttachment(attachmentId: string): Effect.Effect<ArrayBuffer, ValidationError | NotFoundError | CommonErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.attachmentOps.downloadAttachment(attachmentId)),
    );
  }

  uploadAttachment(pageId: string, file: globalThis.File, comment?: string): Effect.Effect<Attachment, AllErrors> {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.attachmentOps.uploadAttachment(pageId, file, comment)),
    );
  }

  // ============= Batch Operations =============
  batchGetPages(pageIds: string[], concurrency?: number): Stream.Stream<Page, AllErrors> {
    return pipe(
      Stream.fromEffect(this.initializeOperations()),
      Stream.flatMap(() => this.batchOps.batchGetPages(pageIds, concurrency)),
    );
  }

  batchUpdatePages(
    updates: Array<{ pageId: string; options: ContentUpdateOptions }>,
  ): Effect.Effect<
    Array<{ pageId: string; success: boolean; error?: string }>,
    ValidationError | CommonErrors | NotFoundError
  > {
    return pipe(
      this.initializeOperations(),
      Effect.flatMap(() => this.batchOps.batchUpdatePages(updates)),
    );
  }
}
