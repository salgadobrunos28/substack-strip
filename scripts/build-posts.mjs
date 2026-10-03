#!/usr/bin/env node
// Turns the Ecologies of Care Substack feed into posts.json for the homepage strip.
// Runs on a schedule in GitHub Actions (.github/workflows/update-posts.yml).
// No dependencies. Needs Node 20 or newer.
//
// Test locally with a saved feed:  FEED_FILE=feed.xml node scripts/build-posts.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PUBLICATION = 'https://ecologiesofcare.substack.com';
const FEED_URL = `${PUBLICATION}/feed`;
const ARCHIVE_API = `${PUBLICATION}/api/v1/archive?sort=new&limit=20`;
const OUT_FILE = new URL('../posts.json', import.meta.url);
const MAX_POSTS = 12;
const SUMMARY_MAX = 240;

// Substack's image CDN crops and compresses on request. 600x450 covers a card at 2x
// and keeps each image small, which matters on a site that shows its own CO2 footprint.
const IMAGE_TRANSFORM = 'w_600,h_450,c_fill,f_auto,q_auto:good,fl_progressive:steep';
// Posts without their own image fall back to the publication logo. The logo is kept whole
// (no crop) so the strip can show it small and centred.
const LOGO_TRANSFORM = 'w_400,h_400,c_fit,f_auto,q_auto:good';

// Substack sits behind Cloudflare, which turns away unfamiliar clients on GitHub's servers.
// Requests therefore go out with ordinary browser headers, first through Node's fetch and
// then through curl. The feed is the project's own public RSS, read every three hours.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ACCEPT_RSS = 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7';
const ACCEPT_JSON = 'application/json, text/plain;q=0.9, */*;q=0.8';
const ACCEPT_LANGUAGE = 'en-GB,en;q=0.9';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', hellip: '\u2026',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Substack sometimes encodes entities twice (&amp;#233;), so decode up to two passes.
function decodeEntities(input = '') {
  let out = String(input);
  for (let pass = 0; pass < 2; pass++) {
    const next = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
      }
      return NAMED_ENTITIES[code] ?? match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match) return '';
  const inner = match[1];
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  // Outside CDATA the markup itself is escaped, so decode before stripping tags.
  return cdata ? cdata[1] : decodeEntities(inner);
}

function attr(xml, name, attribute) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*?\\s${attribute}="([^"]*)"`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function toText(html = '') {
  const withoutTags = String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function truncate(text, max = SUMMARY_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).replace(/[\s,;:.-]+$/, '') + '\u2026';
}

// Feed images arrive either wrapped in a substackcdn fetch URL or as the raw S3 file.
function originalImage(url) {
  if (!url) return '';
  const wrapped = url.match(/\/(https?%3A%2F%2F[^?#]+)/i);
  const original = wrapped ? decodeURIComponent(wrapped[1]) : url;
  return original.startsWith('https://') ? original : '';
}

const cdnImage = (original, transform) =>
  original ? `https://substackcdn.com/image/fetch/${transform}/${encodeURIComponent(original)}` : '';

function makePost({ title, summary, url, date, author, image, type, logo = '' }) {
  let original = originalImage(image);
  const logoOriginal = originalImage(logo);
  // No image of its own, or Substack's default cover: use the publication logo.
  const isLogo = Boolean(logoOriginal) && (!original || original === logoOriginal);
  if (isLogo) original = logoOriginal;
  const parsedDate = new Date(date);
  return {
    title: title.replace(/\s*:\s*$/, ''),
    summary: truncate(summary || ''),
    url,
    date: isNaN(parsedDate) ? '' : parsedDate.toISOString(),
    author: author || 'Ecologies of Care',
    type: type === 'podcast' ? 'podcast' : 'article',
    image: cdnImage(original, isLogo ? LOGO_TRANSFORM : IMAGE_TRANSFORM),
    imageOriginal: original,
    logo: isLogo,
  };
}

const isValid = post => post.title && post.url.startsWith('https://') && post.date;

function postsFromRss(xml) {
  if (!/<rss\b/i.test(xml)) throw new Error('response is not an RSS feed');
  const channelHead = (xml.match(/<channel\b[\s\S]*?(?=<item\b)/i) || [''])[0];
  const logo = toText(tag(tag(channelHead, 'image'), 'url'));
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(item => {
    const isAudio = /^audio\//i.test(attr(item, 'enclosure', 'type'));
    const description = toText(tag(item, 'description'));
    return makePost({
      title: toText(tag(item, 'title')),
      summary: description || toText(tag(item, 'content:encoded')),
      url: toText(tag(item, 'link')),
      date: toText(tag(item, 'pubDate')),
      author: toText(tag(item, 'dc:creator')),
      image: isAudio ? attr(item, 'itunes:image', 'href') : attr(item, 'enclosure', 'url'),
      type: isAudio ? 'podcast' : 'article',
      logo,
    });
  });
}

function postsFromArchive(list) {
  if (!Array.isArray(list)) throw new Error('archive API returned an unexpected shape');
  return list.filter(p => p && p.canonical_url).map(p => makePost({
    title: toText(p.title || ''),
    summary: toText(p.subtitle || p.description || p.truncated_body_text || ''),
    url: p.canonical_url,
    date: p.post_date,
    author: p.publishedBylines?.[0]?.name || '',
    image: p.cover_image || '',
    type: p.type === 'podcast' ? 'podcast' : 'article',
  }));
}

async function viaFetch(url, accept) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': ACCEPT_LANGUAGE },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;   // retrying will not help
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) await sleep(attempt * 5000);
  }
  throw lastError;
}

const execFileAsync = promisify(execFile);

async function viaCurl(url, accept) {
  const { stdout } = await execFileAsync('curl', [
    '--silent', '--show-error', '--location', '--compressed', '--max-time', '20',
    '--user-agent', USER_AGENT,
    '--header', `Accept: ${accept}`,
    '--header', `Accept-Language: ${ACCEPT_LANGUAGE}`,
    '--write-out', '\n%{http_code}',
    url,
  ], { maxBuffer: 20 * 1024 * 1024 });
  const cut = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(cut + 1));
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return stdout.slice(0, cut);
}

async function collect() {
  if (process.env.FEED_FILE) return postsFromRss(await readFile(process.env.FEED_FILE, 'utf8'));

  const sources = [
    ['feed via fetch', () => viaFetch(FEED_URL, ACCEPT_RSS).then(postsFromRss)],
    ['feed via curl', () => viaCurl(FEED_URL, ACCEPT_RSS).then(postsFromRss)],
    ['archive API via fetch', () => viaFetch(ARCHIVE_API, ACCEPT_JSON).then(t => postsFromArchive(JSON.parse(t)))],
    ['archive API via curl', () => viaCurl(ARCHIVE_API, ACCEPT_JSON).then(t => postsFromArchive(JSON.parse(t)))],
  ];
  const failures = [];
  for (const [name, read] of sources) {
    try {
      const posts = await read();
      console.log(`::notice::Read ${posts.length} posts (${name}).`);
      return posts;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(failures.join('; '));
}

async function main() {
  let posts;
  try {
    posts = await collect();
  } catch (err) {
    console.log(`::warning::Could not read Substack (${err.message}). posts.json was left as it was.`);
    return;
  }

  const seen = new Set();
  posts = posts
    .filter(isValid)
    .filter(post => !seen.has(post.url) && seen.add(post.url))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_POSTS);

  if (!posts.length) {
    console.log('::warning::Substack returned no posts. posts.json was left as it was.');
    return;
  }

  let previous = null;
  try { previous = JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { /* first run */ }
  if (previous && JSON.stringify(previous.posts) === JSON.stringify(posts)) {
    console.log('No new posts. posts.json unchanged.');
    return;
  }

  const data = { updated: new Date().toISOString(), source: FEED_URL, posts };
  await writeFile(OUT_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${posts.length} posts to posts.json.`);
}

main();
