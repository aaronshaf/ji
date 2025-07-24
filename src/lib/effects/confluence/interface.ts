/**
 * Confluence Client Service Interface
 * Defines the service interface and context tag
 */

import { Context, type Effect, type Option, type Stream } from 'effect';
import type { NotFoundError, ValidationError } from '../errors.js';
import type { Attachment, Page, Space } from './schemas.js';
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

// ============= Confluence Client Service Interface =============
export interface ConfluenceClientService {
  // Space operations
  readonly getSpace: (spaceKey: string) => Effect.Effect<Space, ValidationError | NotFoundError | CommonErrors>;
  readonly getAllSpaces: (options?: SearchOptions) => Effect.Effect<SpaceSearchResult, CommonErrors | NotFoundError>;
  readonly getSpacePermissions: (
    spaceKey: string,
  ) => Effect.Effect<
    ReadonlyArray<{ operation: string; targetType: string }> | Array<{ operation: string; targetType: string }>,
    ValidationError | NotFoundError | CommonErrors
  >;

  // Content retrieval
  readonly getPage: (pageId: string, expand?: string[]) => Effect.Effect<Page, AllErrors>;
  readonly getPageByTitle: (
    spaceKey: string,
    title: string,
  ) => Effect.Effect<Option.Option<Page>, ValidationError | CommonErrors | NotFoundError>;
  readonly getSpaceContent: (
    spaceKey: string,
    options?: SpaceContentOptions,
  ) => Effect.Effect<PageSearchResult, ValidationError | CommonErrors | NotFoundError>;
  readonly getAllSpacePages: (spaceKey: string) => Stream.Stream<Page, ValidationError | CommonErrors | NotFoundError>;
  readonly getChildPages: (pageId: string, expand?: string[]) => Effect.Effect<readonly Page[] | Page[], AllErrors>;
  readonly getPageAncestors: (
    pageId: string,
  ) => Effect.Effect<ReadonlyArray<{ id: string; title: string }> | Array<{ id: string; title: string }>, AllErrors>;

  // Content search and discovery
  readonly searchContent: (
    cql: string,
    options?: SearchOptions,
  ) => Effect.Effect<Array<PageSummary>, ValidationError | CommonErrors | NotFoundError>;
  readonly getRecentlyUpdatedPages: (
    spaceKey: string,
    limit?: number,
  ) => Effect.Effect<PageSummary[], ValidationError | CommonErrors | NotFoundError>;
  readonly getPagesSince: (
    spaceKey: string,
    sinceDate: Date,
  ) => Stream.Stream<string, ValidationError | CommonErrors | NotFoundError>;
  readonly getSpacePagesLightweight: (
    spaceKey: string,
  ) => Stream.Stream<PageSummary, ValidationError | CommonErrors | NotFoundError>;

  // Content creation and updates
  readonly createPage: (
    options: ContentCreationOptions,
  ) => Effect.Effect<Page, ValidationError | CommonErrors | NotFoundError>;
  readonly updatePage: (pageId: string, options: ContentUpdateOptions) => Effect.Effect<Page, AllErrors>;
  readonly deletePage: (pageId: string) => Effect.Effect<void, ValidationError | NotFoundError | CommonErrors>;
  readonly movePage: (
    pageId: string,
    targetSpaceKey: string,
    targetParentId?: string,
  ) => Effect.Effect<Page, AllErrors>;

  // Attachment operations
  readonly getPageAttachments: (pageId: string) => Effect.Effect<Attachment[], AllErrors>;
  readonly downloadAttachment: (
    attachmentId: string,
  ) => Effect.Effect<ArrayBuffer, ValidationError | NotFoundError | CommonErrors>;
  readonly uploadAttachment: (
    pageId: string,
    file: globalThis.File,
    comment?: string,
  ) => Effect.Effect<Attachment, AllErrors>;

  // Batch operations
  readonly batchGetPages: (pageIds: string[], concurrency?: number) => Stream.Stream<Page, AllErrors>;
  readonly batchUpdatePages: (
    updates: Array<{ pageId: string; options: ContentUpdateOptions }>,
  ) => Effect.Effect<
    Array<{ pageId: string; success: boolean; error?: string }>,
    ValidationError | CommonErrors | NotFoundError
  >;

  // Analytics and monitoring
  readonly getSpaceAnalytics: (
    spaceKey: string,
  ) => Effect.Effect<
    { pageCount: number; recentActivity: number; lastModified?: Date },
    ValidationError | CommonErrors | NotFoundError
  >;
  readonly validateSpaceAccess: (
    spaceKey: string,
  ) => Effect.Effect<boolean, ValidationError | CommonErrors | NotFoundError>;
}

export class ConfluenceClientServiceTag extends Context.Tag('ConfluenceClientService')<
  ConfluenceClientServiceTag,
  ConfluenceClientService
>() {}
