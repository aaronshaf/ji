/**
 * Confluence API Schemas
 * All Effect schemas for Confluence API responses
 */

import { Schema } from 'effect';

// ============= Page Schema =============
export const PageSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  title: Schema.String,
  space: Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    id: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
  }),
  version: Schema.Struct({
    number: Schema.Number,
    when: Schema.String,
    by: Schema.optional(
      Schema.Struct({
        displayName: Schema.String,
        userKey: Schema.optional(Schema.String),
        accountId: Schema.optional(Schema.String),
      }),
    ),
    message: Schema.optional(Schema.String),
  }),
  body: Schema.optional(
    Schema.Struct({
      storage: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.Literal('storage'),
        }),
      ),
      view: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.Literal('view'),
        }),
      ),
      atlas_doc_format: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.Literal('atlas_doc_format'),
        }),
      ),
    }),
  ),
  _links: Schema.Struct({
    self: Schema.String,
    webui: Schema.String,
    base: Schema.optional(Schema.String),
  }),
  ancestors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
      }),
    ),
  ),
});

// ============= Space Schema =============
export const SpaceSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  key: Schema.String,
  name: Schema.String,
  type: Schema.String,
  status: Schema.String,
  description: Schema.optional(
    Schema.Struct({
      plain: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.Literal('plain'),
        }),
      ),
    }),
  ),
  homepage: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
    }),
  ),
  _links: Schema.Struct({
    self: Schema.String,
    webui: Schema.String,
    base: Schema.optional(Schema.String),
  }),
  permissions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        operation: Schema.String,
        targetType: Schema.String,
      }),
    ),
  ),
});

// ============= List Response Schemas =============
export const PageListResponseSchema = Schema.Struct({
  results: Schema.Array(PageSchema),
  start: Schema.Number,
  limit: Schema.Number,
  size: Schema.Number,
  _links: Schema.optional(
    Schema.Struct({
      base: Schema.optional(Schema.String),
      context: Schema.optional(Schema.String),
      next: Schema.optional(Schema.String),
      prev: Schema.optional(Schema.String),
    }),
  ),
});

export const SpaceListResponseSchema = Schema.Struct({
  results: Schema.Array(SpaceSchema),
  start: Schema.Number,
  limit: Schema.Number,
  size: Schema.Number,
  _links: Schema.optional(
    Schema.Struct({
      base: Schema.optional(Schema.String),
      context: Schema.optional(Schema.String),
      next: Schema.optional(Schema.String),
      prev: Schema.optional(Schema.String),
    }),
  ),
});

// ============= Search Result Schemas =============
export const SearchResultSchema = Schema.Struct({
  content: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    title: Schema.String,
    space: Schema.optional(
      Schema.Struct({
        key: Schema.String,
        name: Schema.String,
      }),
    ),
    version: Schema.optional(
      Schema.Struct({
        number: Schema.Number,
        when: Schema.String,
        by: Schema.optional(
          Schema.Struct({
            displayName: Schema.String,
          }),
        ),
      }),
    ),
    _links: Schema.Struct({
      webui: Schema.String,
      self: Schema.optional(Schema.String),
    }),
  }),
  url: Schema.optional(Schema.String),
  lastModified: Schema.optional(Schema.String),
});

export const SearchResponseSchema = Schema.Struct({
  results: Schema.Array(SearchResultSchema),
  start: Schema.Number,
  limit: Schema.Number,
  size: Schema.Number,
  totalSize: Schema.optional(Schema.Number),
  _links: Schema.optional(
    Schema.Struct({
      base: Schema.optional(Schema.String),
      context: Schema.optional(Schema.String),
      next: Schema.optional(Schema.String),
      prev: Schema.optional(Schema.String),
    }),
  ),
});

// ============= Attachment Schema =============
export const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('attachment'),
  status: Schema.String,
  title: Schema.String,
  version: Schema.Struct({
    number: Schema.Number,
    when: Schema.String,
    by: Schema.optional(
      Schema.Struct({
        displayName: Schema.String,
      }),
    ),
  }),
  container: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
  }),
  metadata: Schema.optional(
    Schema.Struct({
      mediaType: Schema.String,
      fileSize: Schema.optional(Schema.Number),
      comment: Schema.optional(Schema.String),
    }),
  ),
  _links: Schema.Struct({
    self: Schema.String,
    webui: Schema.String,
    download: Schema.String,
  }),
});

// ============= Exported Types =============
export type Page = Schema.Schema.Type<typeof PageSchema>;
export type Space = Schema.Schema.Type<typeof SpaceSchema>;
export type Attachment = Schema.Schema.Type<typeof AttachmentSchema>;
