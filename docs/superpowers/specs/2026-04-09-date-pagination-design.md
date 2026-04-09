# Date-Paginated Stream + Social Unfurl Meta Tags (Design)

**Date:** 2026-04-09  
**Status:** Approved (ready for implementation planning)

## Goal

Introduce a blog-like stream view that:

- Shows multiple posts in a chronological stream on the homepage (configurable).
- Paginates **by date**, with a minimum post count on the stream landing view, but **never splits a day**.
- Supports navigating to **exactly one day** of posts (older/newer).
- Adds robust social media meta tags so links unfurl nicely (Open Graph + Twitter).

## Non-goals

- Changing the underlying post storage format (`.txt` + YAML frontmatter).
- Replacing `/read/:id` pages or their URLs.
- Building an admin UI toggle (configuration is via environment variables only).

## Current system (summary)

- Server: `src/server.js` (Express + Handlebars).
- Posts: parsed from text files by `src/parser.js`, with metadata including `date` and derived `datestamp: Date`.
- Views:
  - `/`: renders `design/home.handlebars` for the latest post plus a list of recent posts.
  - `/archive`: renders a full list of all posts.
  - `/read/*`: renders `design/home.handlebars` for a single post.
- Layout: `design/layouts/main.handlebars` (contains partial OG tags only when `post` exists).

## Requirements

### R1: Configurable homepage mode

Add an environment variable:

- `HOME_MODE=single|stream`
  - `single`: keep existing homepage behavior.
  - `stream`: homepage renders the new date-paginated stream.

Regardless of `HOME_MODE`, the stream must be available at a stable route (`/stream`).

### R2: Stream landing view (`/stream`) is date-paginated with a minimum post count

Add `MIN_POSTS_PER_PAGE` (default \(10\)).

Behavior:

- `/stream` renders a stream of posts spanning **whole days** until at least `MIN_POSTS_PER_PAGE` posts are included.
- A day is treated as an indivisible unit:
  - If adding the next day causes the total to exceed the minimum, include it anyway (do not split).

Example:

- Minimum is 10.
- If there are 3 posts per day, `/stream` shows 4 days (12 posts) because 3 days is only 9 posts and we must include the next day.

### R3: Single-day view (`/stream/:date`) shows exactly one day’s posts

Route format:

- `/stream/YYYY-MM-DD`

Behavior:

- Show posts for that date only.
- It is acceptable for the day to have fewer than `MIN_POSTS_PER_PAGE` posts.

### R4: Navigation

Navigation must skip empty days.

- From `/stream`:
  - “Older posts” goes to the **previous day that has posts** (i.e. the day immediately older than the oldest day shown on `/stream`).
- From `/stream/:date`:
  - “Newer posts” goes to the next day with posts (chronologically newer).
  - “Older posts” goes to the previous day with posts (chronologically older).

### R5: Rendering and templates

- Create `design/stream.handlebars` for the stream UI.
- Do not remove/replace existing templates; keep `design/home.handlebars` and `design/archive.handlebars` intact.
- The stream should render **full post content** (`post.rendered`) for each post in the stream.

### R6: Social media unfurl meta tags

The HTML layout should reliably emit:

- Open Graph tags (`og:*`)
- Twitter card tags (`twitter:*`)

Approach:

- Pass a `meta` object to all renders and have `design/layouts/main.handlebars` render tags from it.
- `meta` fields:
  - `meta.title` (string)
  - `meta.description` (string)
  - `meta.url` (string; canonical URL for the current page)
  - `meta.type` (string; `article` for `/read/:id`, `website` otherwise)
  - `meta.image` (string; optional, from `SOCIAL_IMAGE_URL` if set)

Notes:

- For `/read/:id`, use the post title and an excerpt as description.
- For `/stream` and `/stream/:date`, use a stream-specific title and description (site-wide fallback OK).

## Data semantics and algorithm

### Day keying

Use a stable day key string:

- `YYYY-MM-DD`

Derived from `post.metadata.datestamp` (a `Date`) using local-time components (consistent with how new posts are created via local dates).

### Grouping

From `parser.sortDesc('datestamp')`, build:

- `postsByDay: Record<dayKey, Post[]>` (each list already in descending order)
- `dayKeysDesc: dayKey[]` in descending order (newest to oldest)

### `/stream` selection

- Iterate over `dayKeysDesc` from newest.
- Add each whole day’s posts to the output until total posts \( \ge \) `MIN_POSTS_PER_PAGE`.
- Track:
  - `daysShown` (array of day keys)
  - `postsToRender` (flattened posts)
  - `olderLinkDay` (the next day key after the oldest shown day, if any)

### Adjacent-day navigation for `/stream/:date`

Given `dayKeysDesc`:

- `newerDay`: the previous element in `dayKeysDesc` (index - 1), if it exists
- `olderDay`: the next element in `dayKeysDesc` (index + 1), if it exists

If the requested day doesn’t exist, return 404.

## Routes (summary)

- `GET /`:
  - if `HOME_MODE=stream`, behaves like `GET /stream`
  - else current behavior (latest post)
- `GET /stream`: landing stream
- `GET /stream/:date`: single-day stream
- `GET /read/:id`: unchanged
- `GET /archive`: unchanged

## Environment variables

- `HOME_MODE`: `single` (default) | `stream`
- `MIN_POSTS_PER_PAGE`: number (default `10`)
- `SOCIAL_IMAGE_URL`: optional absolute URL for OG/Twitter image
- Existing: `BASE_URL`, `ROOT_URL`, `SITE_NAME`, etc.

## SEO / canonical considerations

- `meta.url` should always be a fully-qualified URL, built from `BASE_URL` + route path.
- Use the exact current page URL as canonical (no trailing slash normalization changes required).

## Open questions (none)

All key decisions have been made:

- Config via env var (not admin UI).
- Date is in the path.
- `/stream` uses whole-day aggregation to reach minimum.
- `/stream/:date` is exactly one day (even if fewer than minimum).

