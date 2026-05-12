const fs = require('fs');
const yaml = require('yaml');
const debug = require('debug')('textfiles:parser');
const glob = require('glob');
const path = require('path');
const MarkdownIt = require('markdown-it');

/**
 * Markdown with links, images, and fenced / inline code. Uses the `zero` preset
 * plus fence, backticks (inline code), link, and image (no arbitrary HTML).
 * @see https://markdown-it.github.io/markdown-it/
 * @returns {MarkdownIt}
 */
function createMarkdown() {
  const md = new MarkdownIt('zero', {
    html: false,
    breaks: false,
    linkify: false,
  }).enable(['link', 'image', 'fence', 'backticks']);

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
 * Renders minimal Markdown to HTML, then substitutes lone `video:` lines with embeds.
 * @param {string} markdownBody
 * @returns {string}
 */
function renderPostHtml(markdownBody) {
  return replaceVideoDirectivesInHtml(md.render(markdownBody));
}

const parser = {
  _cache: [],
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
