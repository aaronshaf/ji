/**
 * Confluence API Schemas
 * All Zod schemas for Confluence API responses
 */

import { z } from 'zod';

// ============= Page Schema =============
export const PageSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  space: z.object({
    key: z.string(),
    name: z.string(),
    id: z.string().optional(),
    type: z.string().optional(),
  }),
  version: z.object({
    number: z.number(),
    when: z.string(),
    by: z
      .object({
        displayName: z.string(),
        userKey: z.string().optional(),
        accountId: z.string().optional(),
      })
      .optional(),
    message: z.string().optional(),
  }),
  body: z
    .object({
      storage: z
        .object({
          value: z.string(),
          representation: z.literal('storage'),
        })
        .optional(),
      view: z
        .object({
          value: z.string(),
          representation: z.literal('view'),
        })
        .optional(),
      atlas_doc_format: z
        .object({
          value: z.string(),
          representation: z.literal('atlas_doc_format'),
        })
        .optional(),
    })
    .optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    base: z.string().optional(),
  }),
  ancestors: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
      }),
    )
    .optional(),
});

// ============= Space Schema =============
export const SpaceSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  description: z
    .object({
      plain: z
        .object({
          value: z.string(),
          representation: z.literal('plain'),
        })
        .optional(),
    })
    .optional(),
  homepage: z
    .object({
      id: z.string(),
      title: z.string(),
    })
    .optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    base: z.string().optional(),
  }),
  permissions: z
    .array(
      z.object({
        operation: z.string(),
        targetType: z.string(),
      }),
    )
    .optional(),
});

// ============= List Response Schemas =============
export const PageListResponseSchema = z.object({
  results: z.array(PageSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z
    .object({
      base: z.string().optional(),
      context: z.string().optional(),
      next: z.string().optional(),
      prev: z.string().optional(),
    })
    .optional(),
});

export const SpaceListResponseSchema = z.object({
  results: z.array(SpaceSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  _links: z
    .object({
      base: z.string().optional(),
      context: z.string().optional(),
      next: z.string().optional(),
      prev: z.string().optional(),
    })
    .optional(),
});

// ============= Search Result Schemas =============
export const SearchResultSchema = z.object({
  content: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    space: z
      .object({
        key: z.string(),
        name: z.string(),
      })
      .optional(),
    version: z
      .object({
        number: z.number(),
        when: z.string(),
        by: z
          .object({
            displayName: z.string(),
          })
          .optional(),
      })
      .optional(),
    _links: z.object({
      webui: z.string(),
      self: z.string().optional(),
    }),
  }),
  url: z.string().optional(),
  lastModified: z.string().optional(),
});

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  start: z.number(),
  limit: z.number(),
  size: z.number(),
  totalSize: z.number().optional(),
  _links: z
    .object({
      base: z.string().optional(),
      context: z.string().optional(),
      next: z.string().optional(),
      prev: z.string().optional(),
    })
    .optional(),
});

// ============= Attachment Schema =============
export const AttachmentSchema = z.object({
  id: z.string(),
  type: z.literal('attachment'),
  status: z.string(),
  title: z.string(),
  version: z.object({
    number: z.number(),
    when: z.string(),
    by: z
      .object({
        displayName: z.string(),
      })
      .optional(),
  }),
  container: z.object({
    id: z.string(),
    title: z.string(),
  }),
  metadata: z
    .object({
      mediaType: z.string(),
      fileSize: z.number().optional(),
      comment: z.string().optional(),
    })
    .optional(),
  _links: z.object({
    self: z.string(),
    webui: z.string(),
    download: z.string(),
  }),
});

// ============= Exported Types =============
export type Page = z.infer<typeof PageSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
