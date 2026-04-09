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
        const rendered = `${md.render(content)}`;
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
