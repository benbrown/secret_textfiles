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

app.use(rootUrl, express.static('public'))
app.use(bodyParser.urlencoded({ extended: true }));

// require users to login based on the USERS env variable
const auth = basicAuth({
  users: loadUsers(process.env.USERS),
  challenge: true,
})

 
app.get(`${ rootUrl }/`, async (req, res) => {
    // parser.parse(path.join(process.env.PATH_TO_TEXT,'2021-02-01.txt'));
    await parser.loadText(process.env.PATH_TO_TEXT, true);

    const latestPost = parser.sortDesc('datestamp')[0];
    const mostRecentPosts = parser.sortDesc('datestamp').slice(0, process.env.RECENT_POSTS);

    res.render('home', {
      rootUrl: rootUrl,
      title: process.env.SITE_NAME,
      post: latestPost,
      mostRecentPosts: mostRecentPosts,
    });  
});

app.get(`${ rootUrl }/archive`, async (req, res) => {
  // parser.parse(path.join(process.env.PATH_TO_TEXT,'2021-02-01.txt'));
  await parser.loadText(process.env.PATH_TO_TEXT, true);

  res.render('archive', {

    rootUrl: rootUrl,
    title: process.env.SITE_NAME,
    posts: parser.sortDesc('datestamp'),
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
  });
});

 
app.listen(process.env.PORT || 3000);