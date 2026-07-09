const fs = require('fs');
const yaml = require('yaml');
const debug = require('debug')('textfiles:parser');
const glob = require('glob');
const path = require('path');
const MarkdownIt = require('markdown-it');

/**
 * Markdown with links, images, blockquotes, and fenced / inline code. Uses the
 * `zero` preset plus fence, backticks (inline code), link, image, and blockquote
 * (no arbitrary HTML).
 * @see https://markdown-it.github.io/markdown-it/
 * @returns {MarkdownIt}
 */
function createMarkdown() {
  const md = new MarkdownIt('zero', {
    html: false,
    breaks: false,
    linkify: false,
  }).enable(['link', 'image', 'fence', 'backticks', 'blockquote']);

  const linkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return linkOpen
      ? linkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  const imageRule = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('loading', 'lazy');
    tokens[idx].attrSet('decoding', 'async');
    return imageRule(tokens, idx, options, env, self);
  };

  return md;
}

const md = createMarkdown();

/** Hostnames allowed for video: embeds (normalized: no leading `www.`). */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
]);

/** Hostnames allowed for photo: embeds (normalized: no leading `www.`). */
const PHOTO_HOSTS = new Set(['photos.benbrown.com']);

/** @type {Map<string, {image: string, description: string} | null>} */
const photoMetaCache = new Map();

/**
 * Returns true if the string is a plausible YouTube video id (11 chars).
 * @param {string | null | undefined} id
 * @returns {boolean}
 */
function isYouTubeVideoId(id) {
  return typeof id === 'string' && /^[\w-]{11}$/.test(id);
}

/**
 * Parses a user-supplied URL and returns a YouTube video id, or null if unsupported.
 * @param {string} raw
 * @returns {string | null}
 */
function extractYouTubeId(raw) {
  const trimmed = raw.replace(/^<|>$/g, '').trim();
  if (!trimmed) {
    return null;
  }
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0];
    return isYouTubeVideoId(id) ? id : null;
  }
  if (url.pathname === '/watch' || url.pathname.startsWith('/watch')) {
    const v = url.searchParams.get('v');
    return isYouTubeVideoId(v) ? v : null;
  }
  const embedMatch = url.pathname.match(/^\/embed\/([\w-]{11})\/?/);
  if (embedMatch) {
    return embedMatch[1];
  }
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]{11})\/?/);
  if (shortsMatch) {
    return shortsMatch[1];
  }
  return null;
}

/**
 * Builds a responsive YouTube iframe block for an allowed video id.
 * @param {string} videoId
 * @returns {string}
 */
function buildYouTubeEmbedHtml(videoId) {
  const src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`;
  return (
    `<div class="post-video-embed">` +
    `<iframe src="${src}" title="YouTube video player" ` +
    'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
    'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>' +
    `</div>`
  );
}

/**
 * Decodes entities Markdown-it may emit in plain text (e.g. `&amp;` in query strings)
 * so the substring can be parsed with the URL API.
 * @param {string} s
 * @returns {string}
 */
function decodeUrlFromHtml(s) {
  return s.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&');
}

/**
 * After Markdown render, replaces paragraphs whose body is only `video: <url>` with the
 * YouTube embed. The opening tag must be immediately followed by `video` (no space after `<p>`).
 * Fenced code stays in `<pre>` and is not matched.
 * @param {string} html
 * @returns {string}
 */
function replaceVideoDirectivesInHtml(html) {
  const replacer = (full, inner) => {
    const rawUrl = decodeUrlFromHtml(inner.trim());
    const id = extractYouTubeId(rawUrl);
    return id ? buildYouTubeEmbedHtml(id) : full;
  };
  return html.replace(/<p>video:\s*(.+?)\s*<\/p>/gi, replacer);
}

/**
 * Decodes common HTML entities in meta tag content.
 * @param {string} s
 * @returns {string}
 */
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Returns the value of an Open Graph meta tag from raw HTML, or null if missing.
 * @param {string} html
 * @param {string} property
 * @returns {string | null}
 */
function parseOgMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\s+property=["']${escaped}["']\\s+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+property=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

/**
 * Parses a user-supplied URL and returns a canonical photos.benbrown.com page URL, or null.
 * @param {string} raw
 * @returns {string | null}
 */
function normalizePhotoPageUrl(raw) {
  const trimmed = raw.replace(/^<|>$/g, '').trim();
  if (!trimmed) {
    return null;
  }
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!PHOTO_HOSTS.has(host)) {
    return null;
  }
  return `https://photos.benbrown.com${url.pathname}`;
}

/**
 * Fetches og:image and og:description from a photos.benbrown.com page.
 * @param {string} pageUrl
 * @returns {Promise<{image: string, description: string} | null>}
 */
async function fetchPhotoMetadata(pageUrl) {
  if (photoMetaCache.has(pageUrl)) {
    return photoMetaCache.get(pageUrl);
  }
  let html;
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': 'secret_textfiles/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      photoMetaCache.set(pageUrl, null);
      return null;
    }
    html = await res.text();
  } catch (err) {
    debug('photo metadata fetch failed', pageUrl, err);
    photoMetaCache.set(pageUrl, null);
    return null;
  }
  const image = parseOgMetaContent(html, 'og:image');
  const description = parseOgMetaContent(html, 'og:description') || '';
  if (!image) {
    photoMetaCache.set(pageUrl, null);
    return null;
  }
  const meta = { image, description };
  photoMetaCache.set(pageUrl, meta);
  return meta;
}

/**
 * Escapes characters that would break Markdown image alt text.
 * @param {string} s
 * @returns {string}
 */
function escapeMarkdownAlt(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Builds a linked image in Markdown for an embedded photo.
 * @param {string} pageUrl
 * @param {string} imageUrl
 * @param {string} alt
 * @returns {string}
 */
function buildPhotoMarkdown(pageUrl, imageUrl, alt) {
  const altEscaped = escapeMarkdownAlt(alt);
  return `[![${altEscaped}](${imageUrl})](${pageUrl})`;
}

/**
 * Replaces lone `photo: <url>` lines with linked image Markdown fetched from the photo page
 * Open Graph metadata. Intended for save-time expansion, not display.
 * @param {string} markdownBody
 * @returns {Promise<string>}
 */
async function expandPhotoDirectivesInMarkdown(markdownBody) {
  const regex = /^photo:\s*(.+?)\s*$/gm;
  let result = markdownBody;
  for (const match of markdownBody.matchAll(regex)) {
    const full = match[0];
    const rawUrl = match[1].trim();
    const pageUrl = normalizePhotoPageUrl(rawUrl);
    if (!pageUrl) {
      continue;
    }
    const meta = await fetchPhotoMetadata(pageUrl);
    if (!meta) {
      continue;
    }
    const replacement = buildPhotoMarkdown(pageUrl, meta.image, meta.description);
    result = result.replace(full, replacement);
  }
  return result;
}

/**
 * Renders minimal Markdown to HTML, then substitutes lone `video:` lines with embeds.
 * @param {string} markdownBody
 * @returns {string}
 */
function renderPostHtml(markdownBody) {
  return replaceVideoDirectivesInHtml(md.render(markdownBody));
}

const parser = {
  _cache: [],
  expandPhotoDirectivesInMarkdown,
  sortDesc: (fieldName, alwaysInclude, includeDrafts) => {
      return parser._cache.filter((p)=>{return ((p.metadata[fieldName] || alwaysInclude) && (includeDrafts || p.metadata.draft !== true)) }).sort((a, b) => {
        if (a.metadata[fieldName] > b.metadata[fieldName]) {
          return -1;
        } else if (a.metadata[fieldName] < b.metadata[fieldName]) {
          return 1;
        } else {
          return 0;
        }
      });
  },
  loadText: async (pathToFiles, reload) => {
    return new Promise(async (resolve, reject) => {
      if (parser._cache && parser._cache.length && !reload) {
        return resolve(parser._cache);
      } else {
        glob(path.join(pathToFiles,'**/**/*.txt'), async (err, files) => {
          // debug('file list', files);
          const res = [];
          for (const f of files) {
            try {
              const post = await parser.parse(f);
              res.push(post);
            } catch(err) {
              console.error('failed to parse',f);
              console.error(err);
            }
          }
          parser._cache = res;
          resolve(res);
        });
      }
    });

  },
  parse: async (pathToFile) => {
    try {
      const raw = fs.readFileSync(pathToFile, 'utf-8');
      // debug('raw text', raw);
      if (parts = raw.match(/^---\s*([\s\S]*?)\s*---\s*\n([\s\S]*)$/m)) { 
        // debug('components:', parts);
        const raw_metadata = parts[1];
        const content = parts[2];
        const metadata = yaml.parse(raw_metadata);
        const rendered = renderPostHtml(content);
        if (metadata.date) {
          metadata.datestamp = new Date(metadata.date);
        }
        const id = path.relative(process.env.PATH_TO_TEXT, pathToFile).replace(/\.txt$/,'');
        return {id, content, metadata, rendered};

      } else {
        throw new Error('could not parse');
      }

    } catch(err) {
      debug('ERROR IN PARSER', err);
      throw new Error('failed to parse');
    }
  }
}


module.exports = parser;
