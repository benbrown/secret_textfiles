const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Build the full .txt file body with YAML front matter that round-trips safely
 * (e.g. titles containing colons, quotes, or newlines).
 * @param {{ title: string, date: string, draft: boolean, published_at_utc?: string, [key: string]: unknown }} metadata
 * @param {string} markdownBody
 * @returns {string}
 */
function serializePostFile(metadata, markdownBody) {
  const frontMatter = yaml.stringify(metadata).trimEnd();
  return `---\n${frontMatter}\n---\n\n${markdownBody}`;
}

/**
 * Current UTC timestamp as a standard JS ISO string.
 * Example: 2026-04-23T19:12:05.123Z
 * @returns {string}
 */
function nowUtcIsoString() {
  return new Date().toISOString();
}

/**
 * Format a Date as YYYY-MM-DD in local time.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const d = new Date(date);
  let month = '' + (d.getMonth() + 1);
  let day = '' + d.getDate();
  const year = d.getFullYear();

  if (month.length < 2) {
    month = '0' + month;
  }
  if (day.length < 2) {
    day = '0' + day;
  }

  return [year, month, day].join('-');
}

/**
 * Pick a non-colliding .txt path for a calendar day key (YYYY-MM-DD).
 * @param {string} textDir
 * @param {string} dateKey
 * @returns {{ postPath: string, pid: string }}
 */
function allocatePostPath(textDir, dateKey) {
  let postPath = path.join(textDir, `${dateKey}.txt`);
  let version = 2;
  let pid = dateKey;
  while (fs.existsSync(postPath)) {
    pid = `${dateKey}-${version}`;
    postPath = path.join(textDir, `${pid}.txt`);
    version++;
  }
  return { postPath, pid };
}

/**
 * Merge publish metadata when saving, preserving published_at_utc and setting it on draft→published transition.
 * @param {{ draft: boolean, published_at_utc?: string }} metadata
 * @param {{ draft?: boolean, published_at_utc?: string } | null} priorMetadata
 * @returns {{ draft: boolean, published_at_utc?: string }}
 */
function mergePublishMetadata(metadata, priorMetadata) {
  const merged = { ...metadata };
  if (priorMetadata?.published_at_utc) {
    merged.published_at_utc = priorMetadata.published_at_utc;
  } else if (merged.draft !== true && priorMetadata?.draft === true) {
    merged.published_at_utc = nowUtcIsoString();
  } else if (merged.draft !== true && !merged.published_at_utc) {
    merged.published_at_utc = nowUtcIsoString();
  }
  if (merged.draft === true) {
    delete merged.published_at_utc;
  }
  return merged;
}

module.exports = {
  serializePostFile,
  nowUtcIsoString,
  formatDate,
  allocatePostPath,
  mergePublishMetadata,
};
