# Substack strip for ecologiesofcare.net

A row of cards at the bottom of the homepage showing the latest posts from
[ecologiesofcare.substack.com](https://ecologiesofcare.substack.com). Each card shows the
cover image, title, date and author; "Info" opens the summary, and a click anywhere on the
card opens the full article on Substack. The last card links to the archive.

Cargo cannot read the Substack feed by itself, so the strip lives on GitHub Pages and is
embedded on the homepage with an iframe. A scheduled GitHub Action reads the feed every three
hours and updates the cards. Nobody has to touch anything when a new post is published.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The strip itself (the page loaded inside the iframe) |
| `posts.json` | The posts, rewritten automatically by the Action |
| `scripts/build-posts.mjs` | Reads the Substack feed and writes `posts.json` |
| `.github/workflows/update-posts.yml` | Runs the script on a schedule and publishes the site |

## Setup (once)

1. **Create a repository** on GitHub named `substack-strip`, public, under the project's
   account or your own.
2. **Upload these files**, keeping the folders. On a Mac the `.github` folder is hidden in
   Finder: press `Cmd + Shift + .` to show it before dragging the files into
   "Add file > Upload files".
3. **Turn on Pages**: Settings > Pages > Source: **GitHub Actions**.
4. **Run it once**: Actions tab > "Update Substack posts" > **Run workflow**. After about a
   minute the strip is live at `https://ACCOUNT.github.io/substack-strip/`.
5. **Embed it in Cargo**. In the homepage, open Code View and paste this at the end of the
   page content (replace `ACCOUNT`):

   ```html
   <iframe src="https://ACCOUNT.github.io/substack-strip/" title="Latest posts from the Ecologies of Care Substack" loading="lazy"></iframe>
   ```

   Then add this to the CSS editor (Site Settings > CSS/HTML). Cargo strips inline styles,
   so the sizing has to live here:

   ```css
   iframe[src*="substack-strip"] {
     display: block;
     width: 100vw;
     height: 290px;
     margin-left: calc(50% - 50vw);   /* full width, edge to edge */
     border: 0;
     background: transparent;
   }
   @media (max-width: 600px) {
     iframe[src*="substack-strip"] { height: 220px; }
   }
   ```

The cards scale with the iframe height, so `height` is the only value to change for bigger
or smaller cards.

## How it behaves

- **New posts** appear within three hours. For an immediate update, use Run workflow.
- **"New" label** marks posts from the last 30 days; older posts show "Article" or "Podcast".
- **If Substack is unreachable**, the Action keeps the last good list and logs a warning, so
  the homepage never shows an empty or broken strip.
- **Images** come through Substack's CDN, cropped to 600 x 450 and compressed, so the whole
  strip weighs a few hundred KB even when the originals are 4000 px PNGs.
- **Scrolling**: trackpad and touch scroll sideways; with a mouse, click and drag.

## Adjusting

| What | Where |
| --- | --- |
| Card size | `height` in the Cargo CSS above |
| Days a post counts as "New" | `NEW_DAYS` in `index.html` |
| Number of cards | `MAX_CARDS` in `index.html` and `MAX_POSTS` in `scripts/build-posts.mjs` |
| Update frequency | `cron` in `.github/workflows/update-posts.yml` |
| Colours and type | the `:root` block at the top of `index.html` |

## Optional: own address

To serve the strip from `news.ecologiesofcare.net` instead of github.io: in Settings > Pages
set the custom domain, then add a CNAME record `news` pointing to `ACCOUNT.github.io` in
Cargo's DNS settings, and update the iframe `src` and the CSS selector.
