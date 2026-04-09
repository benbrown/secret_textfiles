# Date-Paginated Stream + Meta Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a date-paginated stream view (`/stream`, `/stream/:date`) with a configurable homepage mode and robust Open Graph + Twitter meta tags for clean social unfurls.

**Architecture:** Load posts via existing `parser.loadText()` and `parser.sortDesc('datestamp')`, group posts by `YYYY-MM-DD`, and render a new Handlebars template for stream pages. Centralize meta tags via a `meta` object passed to layouts.

**Tech Stack:** Node.js, Express, express-handlebars, Handlebars templates.

---

### Task 1: Add stream template

**Files:**
- Create: `design/stream.handlebars`

- [ ] **Step 1: Create `design/stream.handlebars`**

Template requirements:
- Render days newest→oldest.
- Under each day heading, render each post’s title, permalink, and full HTML body (`rendered`).
- Render navigation links when provided: `newerUrl` and `olderUrl`.

### Task 2: Add stream routes + grouping logic

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add helper functions (with JSDoc)**

Add helper functions for:
- Converting `Date` → `YYYY-MM-DD` day key (local time).
- Grouping posts by day key.
- Selecting days for `/stream` until reaching `MIN_POSTS_PER_PAGE` without splitting days.
- Finding adjacent day keys for `/stream/:date` navigation.

- [ ] **Step 2: Add new routes**

Add:
- `GET ${rootUrl}/stream`
- `GET ${rootUrl}/stream/:date` (validate `YYYY-MM-DD`)

Ensure:
- `/stream` renders a multi-day stream until minimum reached.
- `/stream/:date` renders exactly one day.
- Navigation skips empty days.

- [ ] **Step 3: Add homepage toggle**

Update `GET ${rootUrl}/`:
- If `HOME_MODE=stream`, behave like `/stream`
- Else keep existing behavior

### Task 3: Add consistent meta tags for social unfurls

**Files:**
- Modify: `src/server.js`
- Modify: `design/layouts/main.handlebars`

- [ ] **Step 1: Add meta-building helpers in `src/server.js` (with JSDoc)**

Add helpers to build a `meta` object for:
- `/read/:id` (article)
- `/stream` and `/stream/:date` (website)
- Fallbacks when optional env vars are not set

Implement a simple excerpt function for descriptions (plain text, truncated).

- [ ] **Step 2: Update `design/layouts/main.handlebars`**

Update layout to emit:
- `og:type`, `og:url`, `og:title`, `og:description`, `og:site_name`
- optional `og:image`
- `twitter:card`, `twitter:title`, `twitter:description`, `twitter:url`
- optional `twitter:image`

Prefer using `meta.*` when present; fall back to `title` / `rootUrl` as needed.

### Task 4: Smoke-check locally

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Start the server**

Run: `npm start`

- [ ] **Step 2: Verify pages render**

Manually visit:
- `/` (both modes by toggling `HOME_MODE`)
- `/stream`
- `/stream/YYYY-MM-DD` (pick an existing date)
- `/read/<id>`

Verify the HTML head includes correct OG/Twitter tags and that stream pagination links work.

