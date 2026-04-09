const fs = require('fs');
const yaml = require('yaml');
const debug = require('debug')('textfiles:parser');
const glob = require('glob');
const path = require('path');
const MarkdownIt = require('markdown-it')
const md = new MarkdownIt({
  html: true,
  linkify: false,
});

/** In-memory cache of zoom URL → embed HTML for repeated URLs in one process. */
const photosZoomEmbedCache = new Map();

/**
 * Decode minimal numeric / named HTML entities for text from OG tags.
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  let s = str;
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  s = s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/&amp;/g, '&');
  return s;
}

/**
 * Escape text for safe use in HTML attributes and text nodes.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read a meta `content` value by Open Graph property from raw HTML.
 * @param {string} html
 * @param {string} property e.g. og:image
 * @returns {string|undefined}
 */
function ogContent(html, property) {
  const re1 = new RegExp(
    `<meta\\s+[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const re2 = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`,
    'i',
  );
  const m = html.match(re1) || html.match(re2);
  return m ? decodeHtmlEntities(m[1]) : undefined;
}

/**
 * Use HTTPS for photos host images to avoid mixed-content when this site is served over HTTPS.
 * @param {string} imageUrl
 * @returns {string}
 */
function ensureHttpsPhotosImage(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.hostname === 'photos.benbrown.com' || u.hostname.endsWith('.photos.benbrown.com')) {
      u.protocol = 'https:';
    }
    return u.toString();
  } catch (e) {
    return imageUrl;
  }
}

/**
 * Fetch a photos.benbrown.com zoom page and build an embed using its Open Graph tags (no iframe).
 * @param {string} rawUrl
 * @returns {Promise<string|false>} HTML fragment or false if not applicable / on failure
 */
async function fetchPhotosZoomEmbed(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!/^https?:\/\/photos\.benbrown\.com\/zoom\/\d+\/?(?:[?#][^\s]*)?$/i.test(trimmed)) {
    return false;
  }
  let pageUrl;
  try {
    const u = new URL(trimmed);
    u.hash = '';
    pageUrl = u.toString();
  } catch (e) {
    return false;
  }

  if (photosZoomEmbedCache.has(pageUrl)) {
    return photosZoomEmbedCache.get(pageUrl);
  }

  try {
    const res = await fetch(pageUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'secret_textfiles/1.0 (embed preview)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      debug('photos zoom fetch failed status', res.status, pageUrl);
      photosZoomEmbedCache.set(pageUrl, false);
      return false;
    }
    const html = await res.text();
    const imageRaw = ogContent(html, 'og:image');
    const titleRaw = ogContent(html, 'og:title');
    const descRaw = ogContent(html, 'og:description');

    if (!imageRaw) {
      debug('photos zoom missing og:image', pageUrl);
      photosZoomEmbedCache.set(pageUrl, false);
      return false;
    }

    const imageUrl = ensureHttpsPhotosImage(imageRaw);
    const title = titleRaw || 'Photo';
    const desc = descRaw || '';
    const alt = escapeHtml(title);
    const safePageUrl = escapeHtml(pageUrl);
    const safeImageUrl = escapeHtml(imageUrl);
    const cap = desc ? `<figcaption>${escapeHtml(desc)}</figcaption>` : '';

    const fragment = `<figure class="photos-embed"><a href="${safePageUrl}" target="_blank" rel="noopener noreferrer"><img src="${safeImageUrl}" alt="${alt}" loading="lazy" decoding="async" /></a>${cap}</figure>`;

    photosZoomEmbedCache.set(pageUrl, fragment);
    return fragment;
  } catch (err) {
    debug('photos zoom embed error', err);
    photosZoomEmbedCache.set(pageUrl, false);
    return false;
  }
}

/**
 * Replace standalone photo zoom URLs in markdown body with OG-based previews.
 * @param {string} content
 * @returns {Promise<string>}
 */
const processEmbeds = async(content) => {
  const urls = content.match(/^https?:\/\/photos\.benbrown\.com\/zoom\/\d+\/?(?:[?#][^\s]*)?\s*$/img);
  if (!urls) return content;

  let out = content;
  for (const url of urls) {
    try {
      const embed = await fetchPhotosZoomEmbed(url);
      if (embed !== false) {
        out = out.replace(url, embed);
      }
    } catch (err) {
      debug('error with photos embed', err);
    }
  }
  return out;
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
      if (parts = raw.match(/^---\s((.|\s)*?)\s---\s+((.|\s)*)/im)) { 
        // debug('components:', parts);
        const content = parts[3];
        const raw_metadata = parts[1];
        const metadata = yaml.parse(raw_metadata);
        const rendered = md.render(await processEmbeds(content)); 
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
