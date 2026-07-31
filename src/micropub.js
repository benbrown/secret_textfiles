const fs = require('fs');
const path = require('path');
const express = require('express');
const parser = require('./parser.js');
const { tokenHasScope } = require('./indieauth.js');
const {
  serializePostFile,
  formatDate,
  allocatePostPath,
  mergePublishMetadata,
} = require('./posts.js');

const PHOTO_DIRECTIVE_RE = /^photo:\s*(.+)\s*$/im;
const MICROPUB_FRONTMATTER_KEYS = {
  'bookmark-of': 'bookmark_of',
  'in-reply-to': 'in_reply_to',
  'like-of': 'like_of',
  rsvp: 'rsvp',
};

/**
 * Send a Micropub JSON error response.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} error
 * @param {string} [description]
 */
function micropubError(res, status, error, description) {
  const body = { error };
  if (description) {
    body.error_description = description;
  }
  return res.status(status).json(body);
}

/**
 * Return the first string value from a Micropub property array.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function firstString(value) {
  if (!Array.isArray(value) || !value.length) {
    return undefined;
  }
  const first = value[0];
  if (typeof first === 'string') {
    return first;
  }
  if (first && typeof first === 'object' && typeof first.value === 'string') {
    return first.value;
  }
  return undefined;
}

/**
 * Return string values from a Micropub property array.
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object' && typeof item.value === 'string') {
        return item.value;
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Parse a published property into a YYYY-MM-DD date key.
 * @param {string | undefined} published
 * @returns {string | undefined}
 */
function dateKeyFromPublished(published) {
  if (!published) {
    return undefined;
  }
  const parsed = new Date(published);
  if (Number.isNaN(parsed.getTime())) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(published)) {
      return published;
    }
    return undefined;
  }
  return formatDate(parsed);
}

/**
 * Extract the first photo: directive URL from markdown.
 * @param {string} markdownBody
 * @returns {string | undefined}
 */
function extractPhotoFromMarkdown(markdownBody) {
  const match = String(markdownBody || '').match(PHOTO_DIRECTIVE_RE);
  return match ? match[1].trim() : undefined;
}

/**
 * Remove photo: directive lines from markdown body.
 * @param {string} markdownBody
 * @returns {string}
 */
function stripPhotoDirectivesFromMarkdown(markdownBody) {
  return String(markdownBody || '')
    .replace(/^photo:\s*.+\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Append a photo directive to markdown when needed.
 * @param {string} markdownBody
 * @param {string | undefined} photoUrl
 * @returns {string}
 */
function appendPhotoDirective(markdownBody, photoUrl) {
  if (!photoUrl) {
    return markdownBody;
  }
  const body = stripPhotoDirectivesFromMarkdown(markdownBody);
  if (!body) {
    return `photo: ${photoUrl}`;
  }
  return `${body}\n\nphoto: ${photoUrl}`;
}

/**
 * Build frontmatter + markdown body from Micropub h-entry properties.
 * @param {Record<string, unknown[]>} properties
 * @param {{ draft?: boolean, published_at_utc?: string, date?: string } | null} [priorMetadata]
 * @returns {{ metadata: Record<string, unknown>, markdownBody: string }}
 */
function micropubPropertiesToPost(properties, priorMetadata = null) {
  const postStatus = firstString(properties['post-status']);
  const isDraft = postStatus === 'draft';

  const metadata = {
    title: firstString(properties.name) || 'Untitled',
    date: dateKeyFromPublished(firstString(properties.published))
      || priorMetadata?.date
      || formatDate(new Date()),
    draft: isDraft,
  };

  const categories = stringArray(properties.category);
  if (categories.length) {
    metadata.categories = categories;
  }

  for (const [micropubKey, frontmatterKey] of Object.entries(MICROPUB_FRONTMATTER_KEYS)) {
    const value = firstString(properties[micropubKey]);
    if (value) {
      metadata[frontmatterKey] = value;
    }
  }

  const merged = mergePublishMetadata(metadata, priorMetadata);

  let markdownBody = firstString(properties.content) || '';
  const photo = stringArray(properties.photo)[0];
  markdownBody = appendPhotoDirective(markdownBody, photo);

  return { metadata: merged, markdownBody };
}

/**
 * Convert a parsed post to Micropub source JSON properties.
 * @param {{ content: string, metadata: Record<string, unknown> }} post
 * @returns {Record<string, string[]>}
 */
function postToMicropubProperties(post) {
  const properties = {};
  const metadata = post.metadata || {};

  if (metadata.title) {
    properties.name = [String(metadata.title)];
  }

  const content = stripPhotoDirectivesFromMarkdown(post.content);
  if (content) {
    properties.content = [content];
  }

  if (metadata.date) {
    properties.published = [String(metadata.date)];
  }

  if (metadata.draft === true) {
    properties['post-status'] = ['draft'];
  }

  if (Array.isArray(metadata.categories) && metadata.categories.length) {
    properties.category = metadata.categories.map(String);
  }

  const photo = extractPhotoFromMarkdown(post.content);
  if (photo) {
    properties.photo = [photo];
  }

  for (const [micropubKey, frontmatterKey] of Object.entries(MICROPUB_FRONTMATTER_KEYS)) {
    if (metadata[frontmatterKey]) {
      properties[micropubKey] = [String(metadata[frontmatterKey])];
    }
  }

  return properties;
}

/**
 * Resolve a post URL or id to a post id.
 * @param {string} urlOrId
 * @param {string} baseUrl
 * @param {string} rootUrl
 * @returns {string | null}
 */
function resolvePostId(urlOrId, baseUrl, rootUrl) {
  const raw = String(urlOrId || '').trim();
  if (!raw) {
    return null;
  }

  const readPrefix = `${baseUrl}${rootUrl}/read/`;
  if (raw.startsWith(readPrefix)) {
    return path.basename(raw.split('?')[0]);
  }

  try {
    const parsed = new URL(raw);
    const prefix = `${rootUrl}/read/`;
    const idx = parsed.pathname.indexOf(prefix);
    if (idx >= 0) {
      return path.basename(parsed.pathname.slice(idx + prefix.length));
    }
  } catch {
    // fall through to basename handling
  }

  if (/^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(raw)) {
    return raw;
  }

  return path.basename(raw);
}

/**
 * Resolve a post id to an on-disk .txt path.
 * @param {string} textDir
 * @param {string} postId
 * @returns {string | null}
 */
function resolvePostPath(textDir, postId) {
  if (!postId || postId.includes('/') || postId.includes('..')) {
    return null;
  }
  const postPath = path.join(textDir, `${postId}.txt`);
  if (!fs.existsSync(postPath)) {
    return null;
  }
  return postPath;
}

/**
 * Apply Micropub replace/add/delete to a property map.
 * @param {Record<string, string[]>} current
 * @param {{ replace?: Record<string, unknown[]>, add?: Record<string, unknown[]>, delete?: Record<string, unknown[]> | string[] }} ops
 * @returns {Record<string, string[]>}
 */
function applyMicropubUpdate(current, ops) {
  const next = { ...current };

  if (ops.replace) {
    for (const [key, values] of Object.entries(ops.replace)) {
      next[key] = stringArray(values);
    }
  }

  if (ops.add) {
    for (const [key, values] of Object.entries(ops.add)) {
      const incoming = stringArray(values);
      if (!incoming.length) {
        continue;
      }
      next[key] = (next[key] || []).concat(incoming);
    }
  }

  if (ops.delete) {
    if (Array.isArray(ops.delete)) {
      for (const key of ops.delete) {
        delete next[key];
      }
    } else {
      for (const [key, values] of Object.entries(ops.delete)) {
        const remove = stringArray(values);
        if (!remove.length) {
          delete next[key];
          continue;
        }
        next[key] = (next[key] || []).filter((item) => !remove.includes(item));
        if (!next[key].length) {
          delete next[key];
        }
      }
    }
  }

  return next;
}

/**
 * Parse form-encoded Micropub create parameters into h-entry properties.
 * @param {Record<string, unknown>} body
 * @returns {Record<string, string[]>}
 */
function formBodyToProperties(body) {
  const properties = {};
  for (const [key, value] of Object.entries(body)) {
    if (['access_token', 'h', 'action', 'url', 'mp-slug'].includes(key) || key.startsWith('mp-')) {
      continue;
    }
    const normalizedKey = key.endsWith('[]') ? key.slice(0, -2) : key;
    const values = Array.isArray(value) ? value : [value];
    properties[normalizedKey] = values.map(String);
  }
  return properties;
}

/**
 * Create Express router for Micropub endpoints.
 * @param {{ baseUrl: string, rootUrl: string, textDir: string, getAccessTokenFromRequest: Function }} options
 * @returns {import('express').Router}
 */
function createMicropubRouter(options) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use(express.urlencoded({ extended: false }));

  /**
   * Require a valid access token, optionally checking scope.
   * @param {string | null} requiredScope
   */
  function requireToken(requiredScope = null) {
    return (req, res, next) => {
      const auth = options.getAccessTokenFromRequest(req);
      if (!auth) {
        return micropubError(res, 401, 'unauthorized', 'Missing or invalid access token');
      }
      if (requiredScope && !tokenHasScope(auth.record, requiredScope)) {
        return micropubError(res, 403, 'insufficient_scope', `Scope "${requiredScope}" is required`);
      }
      req.micropubAuth = auth;
      return next();
    };
  }

  router.get('/', requireToken(), async (req, res) => {
    const queryType = req.query.q;
    if (queryType === 'config') {
      return res.json({});
    }

    if (queryType === 'source') {
      if (!tokenHasScope(req.micropubAuth.record, 'update')) {
        return micropubError(res, 403, 'insufficient_scope', 'Scope "update" is required');
      }

      const sourceUrl = req.query.url;
      if (!sourceUrl || typeof sourceUrl !== 'string') {
        return micropubError(res, 400, 'invalid_request', 'url is required for q=source');
      }

      const postId = resolvePostId(sourceUrl, options.baseUrl, options.rootUrl);
      const postPath = postId ? resolvePostPath(options.textDir, postId) : null;
      if (!postPath) {
        return micropubError(res, 404, 'invalid_request', 'Post not found');
      }

      try {
        const post = await parser.parse(postPath);
        const allProperties = postToMicropubProperties(post);
        const requested = []
          .concat(req.query.properties || [])
          .concat(req.query['properties[]'] || [])
          .filter(Boolean);

        const properties = requested.length
          ? requested.reduce((acc, key) => {
              if (allProperties[key]) {
                acc[key] = allProperties[key];
              }
              return acc;
            }, {})
          : allProperties;

        if (!requested.length) {
          return res.json({
            type: ['h-entry'],
            properties,
          });
        }

        return res.json({ properties });
      } catch (err) {
        return micropubError(res, 500, 'server_error', 'Could not read post');
      }
    }

    return micropubError(res, 400, 'invalid_request', 'Unsupported query');
  });

  router.post('/', requireToken(), async (req, res) => {
    try {
      if (req.body && req.body.action === 'update') {
        if (!tokenHasScope(req.micropubAuth.record, 'update')) {
          return micropubError(res, 403, 'insufficient_scope', 'Scope "update" is required');
        }

        const sourceUrl = req.body.url;
        if (!sourceUrl) {
          return micropubError(res, 400, 'invalid_request', 'url is required for update');
        }
        if (!req.body.replace && !req.body.add && !req.body.delete) {
          return micropubError(res, 400, 'invalid_request', 'update requires replace, add, or delete');
        }

        const postId = resolvePostId(String(sourceUrl), options.baseUrl, options.rootUrl);
        const postPath = postId ? resolvePostPath(options.textDir, postId) : null;
        if (!postPath) {
          return micropubError(res, 404, 'invalid_request', 'Post not found');
        }

        const priorPost = await parser.parse(postPath);
        const current = postToMicropubProperties(priorPost);
        const updated = applyMicropubUpdate(current, req.body);
        const { metadata, markdownBody } = micropubPropertiesToPost(updated, priorPost.metadata);
        const { markdown, failures: photoFailures } =
          await parser.expandPhotoDirectivesInMarkdown(markdownBody);
        if (photoFailures.length) {
          return micropubError(res, 502, 'server_error', 'Could not expand one or more photo directives');
        }

        fs.writeFileSync(postPath, serializePostFile(metadata, markdown));
        return res.status(200).json({});
      }

      if (!tokenHasScope(req.micropubAuth.record, 'create')) {
        return micropubError(res, 403, 'insufficient_scope', 'Scope "create" is required');
      }

      let properties = {};
      if (req.is('application/json')) {
        if (req.body.action) {
          return micropubError(res, 400, 'invalid_request', 'Unsupported action');
        }
        properties = req.body.properties || {};
      } else {
        properties = formBodyToProperties(req.body);
      }

      const { metadata, markdownBody } = micropubPropertiesToPost(properties);
      const dateKey = String(metadata.date);
      const { postPath, pid } = allocatePostPath(options.textDir, dateKey);
      const { markdown, failures: photoFailures } =
        await parser.expandPhotoDirectivesInMarkdown(markdownBody);
      if (photoFailures.length) {
        return micropubError(res, 502, 'server_error', 'Could not expand one or more photo directives');
      }

      fs.writeFileSync(postPath, serializePostFile(metadata, markdown));
      const location = `${options.baseUrl}${options.rootUrl}/read/${pid}`;
      res.set('Location', location);
      return res.status(201).json({});
    } catch (err) {
      return micropubError(res, 500, 'server_error', 'Could not process Micropub request');
    }
  });

  return router;
}

module.exports = {
  createMicropubRouter,
  micropubPropertiesToPost,
  postToMicropubProperties,
  applyMicropubUpdate,
  resolvePostId,
};
