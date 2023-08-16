# Ben Brown's SECRET_TEXTFILES

This is a very simple tool for publishing a blog-like site. It focuses on having ONE post on the front page, and an archive of previous posts. 

There is a posting interface that supports drafts. There is not currently support for uploading files directly into the system.

All files are stored as dated markdown files with YAML headers making it easy to backup or use the content in other ways.

### Install

clone the repo
```git clone git@github.com:benbrown/secret_textfiles.git```

run npm install
```npm install```

set the config options in `.env`

```
USERS="user:password"
PATH_TO_TEXT=./text/
PATH_TO_TEMPLATES=./design/
SITE_NAME=Daily Text
RECENT_POSTS=5
PORT=
ROOT_URL=
BASE_URL=http://localhost:3000
```

USERS should be a username:password combo. This is what is used to login to the posting interface.

PATH_TO_TEXT is the relative path to your collection of text files.

PATH_TO_TEMPLATES is the relative path to your HTML template files.

SITE_NAME is the name of the site, used in the RSS feed.

RECENT_POSTS is how many posts you want to be included in the list of recent posts on the homepage.

PORT is the port to run the service on, this defaults to 3000 if not specified

ROOT_URL is the an optional sub-path for the site, for example `blog`

BASE_URL is the ROOT url of your website


start the service
```npm start```

this should start a webserver on port 3000 or the port you specified.

navigate to the admin page:
```http://localhost:3000/secret```

post away!

### Change the design

There are 3 files involved in the design.

`design/home.handlebars` design of the homepage or individual post

`design/archive.handlebars` design of the archive page

`design/layouts/main.handlebars` the wrapper content into which either the home or archive content is inserted.

CSS files and images can be put into the `public/` folder.

