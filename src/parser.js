const { SSL_OP_NETSCAPE_DEMO_CIPHER_CHANGE_BUG } = require('constants');
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

const fetchEmbed = async(url) => {
  console.log('match url',url)
  if (match = url.match(/\?v=(.*?)(\&|\s|$)/im)) {
    console.log('MATCHED UYOURUTBE');
    const id = match[1];
    return `<div class="youtube-container"><iframe class="responsive-iframe" src="https://www.youtube.com/embed/${ id }" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`
  } else {
    return false;
  }
}

const processEmbeds = async(content) => {

  if (urls = content.match(/^(http.*?youtube.*?)$/img)) {
    for (let url of urls) {
      try {
        let embed = await fetchEmbed(url);
        if (embed !== false) {
          content = content.replace(url, embed);
        }
      } catch(err) {
        debug('error with oembed', err);
      }
    }
  }
  return content;

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
        rendered =md.render(await processEmbeds(content)); 
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