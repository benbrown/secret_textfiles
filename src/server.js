const express = require('express');
const exphbs  = require('express-handlebars');
const bodyParser = require('body-parser');
const debug = require('debug')('textfiles');
const path = require('path');
require('dotenv').config()
const app = express();
const parser = require('./parser.js');
const loadUsers = require('./auth.js');

const fs = require('fs');
const basicAuth = require('express-basic-auth')
const RSS = require('rss-generator');
app.engine('handlebars', exphbs());
app.set('views', process.env.PATH_TO_TEMPLATES)
app.set('view engine', 'handlebars');

const rootUrl = process.env.ROOT_URL;
const baseUrl = process.env.BASE_URL;
const homeMode = process.env.HOME_MODE || 'single';
const minPostsPerPage = (() => {
  const n = parseInt(process.env.MIN_POSTS_PER_PAGE || '10', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
const socialImageUrl = process.env.SOCIAL_IMAGE_URL;

app.use(rootUrl, express.static('public'))
app.use(bodyParser.urlencoded({ extended: true }));

// require users to login based on the USERS env variable
const auth = basicAuth({
  users: loadUsers(process.env.USERS),
  challenge: true,
})

/**
 * Convert a Date to a YYYY-MM-DD key using local time.
 * @param {Date} d
 * @returns {string}
 */
function toDayKeyLocal(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Strip HTML tags and normalize whitespace.
 * @param {string} html
 * @returns {string}
 */
function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Create a truncated excerpt for meta descriptions.
 * @param {string} html
 * @param {number} maxLen
 * @returns {string}
 */
function excerptFromHtml(html, maxLen = 200) {
  const text = stripHtmlToText(html);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Build a canonical absolute URL.
 * @param {string} pathname
 * @returns {string}
 */
function canonicalUrl(pathname) {
  // baseUrl is expected to be absolute, e.g. http://example.com
  return `${baseUrl}${pathname}`;
}

/**
 * Build a meta object for layout social tags.
 * @param {{title?: string, description?: string, url: string, type?: string}} input
 * @returns {{title: string, description?: string, url: string, type: string, image?: string}}
 */
function buildMeta(input) {
  return {
    title: input.title || process.env.SITE_NAME,
    description: input.description,
    url: input.url,
    type: input.type || 'website',
    image: socialImageUrl,
  };
}

/**
 * Group posts by local day key (YYYY-MM-DD) and return day keys in desc order.
 * @param {Array<{id: string, metadata: any, rendered: string}>} postsDesc
 * @returns {{postsByDay: Record<string, any[]>, dayKeysDesc: string[]}}
 */
function groupPostsByDay(postsDesc) {
  const postsByDay = {};
  for (const post of postsDesc) {
    const ds = post?.metadata?.datestamp;
    if (!ds) continue;
    const key = toDayKeyLocal(new Date(ds));
    postsByDay[key] = postsByDay[key] || [];
    postsByDay[key].push(post);
  }
  const dayKeysDesc = Object.keys(postsByDay).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return { postsByDay, dayKeysDesc };
}

/**
 * Select whole days from newest until reaching min posts.
 * @param {Record<string, any[]>} postsByDay
 * @param {string[]} dayKeysDesc
 * @param {number} minPosts
 * @returns {{days: Array<{key: string, posts: any[]}>, olderDay?: string, newestDay?: string, oldestDay?: string}}
 */
function selectDaysUntilMin(postsByDay, dayKeysDesc, minPosts) {
  let total = 0;
  const days = [];
  let oldestDay;
  let newestDay;
  for (const key of dayKeysDesc) {
    if (!newestDay) newestDay = key;
    const posts = postsByDay[key] || [];
    if (!posts.length) continue;
    days.push({ key, posts });
    total += posts.length;
    oldestDay = key;
    if (total >= minPosts) break;
  }
  const oldestIdx = oldestDay ? dayKeysDesc.indexOf(oldestDay) : -1;
  const olderDay = oldestIdx >= 0 ? dayKeysDesc[oldestIdx + 1] : undefined;
  return { days, olderDay, newestDay, oldestDay };
}

/**
 * Find adjacent day keys (newer/older) for a given day.
 * @param {string[]} dayKeysDesc
 * @param {string} dayKey
 * @returns {{newerDay?: string, olderDay?: string}}
 */
function adjacentDays(dayKeysDesc, dayKey) {
  const idx = dayKeysDesc.indexOf(dayKey);
  if (idx < 0) return {};
  return {
    newerDay: dayKeysDesc[idx - 1],
    olderDay: dayKeysDesc[idx + 1],
  };
}

/**
 * Render the stream page for either multi-day (landing) or single-day.
 * @param {import('express').Response} res
 * @param {{rootUrl: string, title: string, headerTitle: string, days: Array<{key: string, posts: any[]}>, newerUrl?: string, olderUrl?: string, meta: any}} model
 */
function renderStream(res, model) {
  return res.render('stream', model);
}

/**
 * Render the stream landing view (/stream) from loaded posts.
 * @param {import('express').Response} res
 * @param {Array<any>} postsDesc
 */
function renderStreamLanding(res, postsDesc) {
  const { postsByDay, dayKeysDesc } = groupPostsByDay(postsDesc);
  const selected = selectDaysUntilMin(postsByDay, dayKeysDesc, minPostsPerPage);
  const olderUrl = selected.olderDay ? `${rootUrl}/stream/${selected.olderDay}` : undefined;

  const meta = buildMeta({
    title: `${process.env.SITE_NAME} — Stream`,
    description: `Latest posts from ${process.env.SITE_NAME}.`,
    url: canonicalUrl(`${rootUrl}/stream`),
    type: 'website',
  });

  return renderStream(res, {
    rootUrl,
    title: process.env.SITE_NAME,
    headerTitle: 'Latest posts',
    days: selected.days,
    olderUrl,
    meta,
  });
}

/**
 * Render a single-day stream view (/stream/:date) from loaded posts.
 * @param {import('express').Response} res
 * @param {Array<any>} postsDesc
 * @param {string} dateKey
 */
function renderStreamDay(res, postsDesc, dateKey) {
  const { postsByDay, dayKeysDesc } = groupPostsByDay(postsDesc);
  const posts = postsByDay[dateKey];
  if (!posts || !posts.length) {
    return res.status(404).send('Missing');
  }

  const { newerDay, olderDay } = adjacentDays(dayKeysDesc, dateKey);
  const newerUrl = newerDay ? `${rootUrl}/stream/${newerDay}` : undefined;
  const olderUrl = olderDay ? `${rootUrl}/stream/${olderDay}` : undefined;

  const meta = buildMeta({
    title: `${process.env.SITE_NAME} — ${dateKey}`,
    description: `Posts from ${dateKey}.`,
    url: canonicalUrl(`${rootUrl}/stream/${dateKey}`),
    type: 'website',
  });

  return renderStream(res, {
    rootUrl,
    title: process.env.SITE_NAME,
    headerTitle: `Posts from ${dateKey}`,
    days: [{ key: dateKey, posts }],
    newerUrl,
    olderUrl,
    meta,
  });
}

 
app.get(`${ rootUrl }/`, async (req, res) => {
    await parser.loadText(process.env.PATH_TO_TEXT, true);
    const postsDesc = parser.sortDesc('datestamp');

    if (homeMode === 'stream') {
      return renderStreamLanding(res, postsDesc);
    }

    const latestPost = postsDesc[0];
    const mostRecentPosts = postsDesc.slice(0, process.env.RECENT_POSTS);

    const meta = latestPost ? buildMeta({
      title: latestPost.metadata?.title || process.env.SITE_NAME,
      description: excerptFromHtml(latestPost.rendered, 200),
      url: canonicalUrl(`${rootUrl}/read/${latestPost.id}`),
      type: 'article',
    }) : buildMeta({
      title: process.env.SITE_NAME,
      description: `Latest posts from ${process.env.SITE_NAME}.`,
      url: canonicalUrl(`${rootUrl}/`),
      type: 'website',
    });

    return res.render('home', {
      rootUrl: rootUrl,
      title: process.env.SITE_NAME,
      post: latestPost,
      mostRecentPosts: mostRecentPosts,
      meta,
    });  
});

app.get(`${rootUrl}/stream`, async (req, res) => {
  await parser.loadText(process.env.PATH_TO_TEXT, true);
  const postsDesc = parser.sortDesc('datestamp');
  return renderStreamLanding(res, postsDesc);
});

app.get(`${rootUrl}/stream/:date`, async (req, res) => {
  const dateKey = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(404).send('Missing');
  }
  await parser.loadText(process.env.PATH_TO_TEXT, true);
  const postsDesc = parser.sortDesc('datestamp');
  return renderStreamDay(res, postsDesc, dateKey);
});

app.get(`${ rootUrl }/archive`, async (req, res) => {
  // parser.parse(path.join(process.env.PATH_TO_TEXT,'2021-02-01.txt'));
  await parser.loadText(process.env.PATH_TO_TEXT, true);

  res.render('archive', {

    rootUrl: rootUrl,
    title: process.env.SITE_NAME,
    posts: parser.sortDesc('datestamp'),
    meta: buildMeta({
      title: `${process.env.SITE_NAME} — Archive`,
      description: `Archive for ${process.env.SITE_NAME}.`,
      url: canonicalUrl(`${rootUrl}/archive`),
      type: 'website',
    }),
  });  
});

app.get(`${ rootUrl }/feed`, async (req, res) => {
  await parser.loadText(process.env.PATH_TO_TEXT, true);

  const publicPosts = parser.sortDesc('datestamp');

  var feed = new RSS({
    title: process.env.SITE_NAME,
    // description: 'description',
    site_url: baseUrl,
    pubDate: publicPosts[0].metadata.datestamp,
  });
 

  publicPosts.forEach((post) => {
    /* loop over data and add to feed */
    feed.item({
        title:  post.metadata.title,
        description: post.rendered,
        url: `${ baseUrl }${ rootUrl }/read/${ post.id }`, // link to the item
        // categories: ['Category 1','Category 2','Category 3','Category 4'], // optional - array of item categories
        // author: 'Guest Author', // optional - defaults to feed author property
        date: post.metadata.date, // any format that js Date can parse.
    });
  });

  res.set('Content-Type', 'text/xml');
  res.send(feed.xml({indent: true}));

});

app.get(`${ rootUrl }/read/*`, async (req, res) => {
  let post;
  const pid = path.basename(req.url); //.replace(/\/read\//,'');
  try {
    const pathToFile = path.join(process.env.PATH_TO_TEXT,`${ pid }.txt`);
    debug('path to file', pathToFile);
    post = await parser.parse(pathToFile);
  } catch(err) {
    debug(err);
    return res.status(404).send('Missing');    
  }

  await parser.loadText(process.env.PATH_TO_TEXT, true);
  const mostRecentPosts = parser.sortDesc('datestamp').slice(0, process.env.RECENT_POSTS);

  res.render('home', {
    rootUrl: rootUrl,
    title: process.env.SITE_NAME,
    post: post,
    mostRecentPosts: mostRecentPosts,
    meta: buildMeta({
      title: post?.metadata?.title || process.env.SITE_NAME,
      description: excerptFromHtml(post?.rendered, 200),
      url: canonicalUrl(`${rootUrl}/read/${post?.id}`),
      type: 'article',
    }),
  });  
});

app.get(`${ rootUrl }/secret/edit/*`, auth, async (req, res) => {
  let post;
  const pid = path.basename(req.url); // .replace(/\/secret\/edit\//,'');
  try {
    const pathToFile = path.join(process.env.PATH_TO_TEXT,`${ pid }.txt`);
    debug('path to file', pathToFile);
    post = await parser.parse(pathToFile);
  } catch(err) {
    debug(err);
    return res.status(404).send('Missing');    
  }

  res.render('secrets/edit', {
    rootUrl: rootUrl,
    title: process.env.SITE_NAME,
    layout: 'secret',
    post: post,
    meta: buildMeta({
      title: `${process.env.SITE_NAME} — Edit`,
      description: `Edit post ${pid}.`,
      url: canonicalUrl(`${rootUrl}/secret/edit/${pid}`),
      type: 'website',
    }),
  });  
});

app.get(`${ rootUrl }/secret/delete/*`, auth, async (req, res) => {
  let post;
  const pid = path.basename(req.url);
  // .replace(/\/secret\/delete\//,'');
  try {
    const pathToFile = path.join(process.env.PATH_TO_TEXT,`${ pid }.txt`);
    debug('path to file', pathToFile);
    post = await parser.parse(pathToFile);
  } catch(err) {
    debug(err);
    return res.status(404).send('Missing');    
  }

  res.render('secrets/delete', {
    rootUrl: rootUrl,
    title: process.env.SITE_NAME,
    layout: 'secret',
    post: post,
    meta: buildMeta({
      title: `${process.env.SITE_NAME} — Delete`,
      description: `Delete post ${pid}.`,
      url: canonicalUrl(`${rootUrl}/secret/delete/${pid}`),
      type: 'website',
    }),
  });  
});

app.post(`${ rootUrl }/secret/delete`, auth, async (req, res) => {
  const pid = req.body.id;
  try {
    const pathToFile = path.join(process.env.PATH_TO_TEXT,`${ pid }.txt`);
    fs.unlinkSync(pathToFile);
  } catch(err) {
    debug(err);
    return res.status(404).send('Missing');    
  }
  res.redirect(`${ rootUrl }/secret`);
});

function formatDate(date) {
  var d = new Date(date),
      month = '' + (d.getMonth() + 1),
      day = '' + d.getDate(),
      year = d.getFullYear();

  if (month.length < 2) 
      month = '0' + month;
  if (day.length < 2) 
      day = '0' + day;

  return [year, month, day].join('-');
}

app.get(`${ rootUrl }/secret/new`, auth, async (req, res) => {

  // what is today's date? format it into a post name
  const today = formatDate(new Date());
  
  const defaultContent = `---
title: New Post
date: ${ today }
draft: true
---

Your post goes here!`;

  // TODO: make sure no overwrite!
  let postPath = path.join(process.env.PATH_TO_TEXT,`${ today }.txt`);
  let version = 2;
  let pid = today;
  while (fs.existsSync(postPath)) {
    postPath = path.join(process.env.PATH_TO_TEXT,`${ today }-${ version }.txt`);
    pid = `${ today }-${ version }`;
   version++;
  }
  fs.writeFileSync(postPath, defaultContent);
  res.redirect(`${ rootUrl }/secret/edit/${ pid }`);

});



app.post(`${ rootUrl }/secret/update`, auth, async (req, res) => {
  const pid = req.body.id;

  let content = `---
title: ${ req.body.title }
date: ${ req.body.date }
draft: ${ req.body.draft || false }
---

${ req.body.content }`;


  let postPath = path.join(process.env.PATH_TO_TEXT,`${ pid }.txt`);
  fs.writeFileSync(postPath, content);
  res.redirect(`${ rootUrl }/secret/edit/${ pid }`);

});



app.get(`${ rootUrl }/secret`, auth, async (req, res) => {
  await parser.loadText(process.env.PATH_TO_TEXT, true);

  res.render('secrets/controlpanel', {
    rootUrl: rootUrl,
    layout: 'secret',
    title: process.env.SITE_NAME,
    posts: parser.sortDesc('datestamp', true, true),
    meta: buildMeta({
      title: `${process.env.SITE_NAME} — Control Panel`,
      description: `Admin control panel.`,
      url: canonicalUrl(`${rootUrl}/secret`),
      type: 'website',
    }),
  });
});

 
app.listen(process.env.PORT || 3000);