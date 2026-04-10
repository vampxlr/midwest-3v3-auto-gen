'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Handlebars = require('handlebars');

const SOURCE_URL = process.env.SOURCE_URL || 'https://www.midwest3on3.com/leagues';
const DATA_DIR = path.join(__dirname, '..', 'data', 'leagues');
const IMAGES_DIR = path.join(__dirname, '..', 'images', 'leagues');
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'leagues');
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'league-landing.hbs');
const HUB_TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'leagues-hub.hbs');

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Download a file from URL to local path
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Generate a URL-safe slug from a name
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Load and compile Handlebars template
function loadTemplate() {
  const src = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return Handlebars.compile(src);
}

// Generate the hub page (public/leagues/index.html) from all league JSON data
function generateHubPage() {
  const seasons = ['spring', 'summer', 'fall'];
  const grouped = { spring: [], summer: [], fall: [] };

  for (const season of seasons) {
    const seasonDir = path.join(DATA_DIR, season);
    if (!fs.existsSync(seasonDir)) continue;
    fs.readdirSync(seasonDir)
      .filter(f => f.endsWith('.json'))
      .forEach(file => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(seasonDir, file), 'utf8'));
          grouped[season].push(data);
        } catch (e) {
          console.error(`  ⚠️  Could not read ${file}: ${e.message}`);
        }
      });
  }

  const src = fs.readFileSync(HUB_TEMPLATE_PATH, 'utf8');
  const template = Handlebars.compile(src);

  // Format last updated date nicely
  const indexPath = path.join(DATA_DIR, 'index.json');
  let lastUpdated = '';
  if (fs.existsSync(indexPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (idx.lastUpdated) {
        lastUpdated = new Date(idx.lastUpdated).toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric'
        });
      }
    } catch (e) { /* ignore */ }
  }

  const context = {
    year: new Date().getFullYear(),
    lastUpdated,
    springLeagues: grouped.spring,
    summerLeagues: grouped.summer,
    fallLeagues:   grouped.fall,
    springCount:   grouped.spring.length,
    summerCount:   grouped.summer.length,
    fallCount:     grouped.fall.length,
    totalCount:    grouped.spring.length + grouped.summer.length + grouped.fall.length,
  };

  const html = template(context);
  ensureDir(path.join(__dirname, '..', 'public', 'leagues'));
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'leagues', 'index.html'), html, 'utf8');
  console.log(`  🗺️  Hub page generated: public/leagues/index.html (${context.totalCount} leagues)`);
  return context.totalCount;
}

// Generate a static HTML landing page from data
function generateLandingPage(leagueData, template) {
  const context = {
    ...leagueData,
    year: new Date().getFullYear(),
    gtmId: process.env.GTM_CONTAINER_ID || '',
    pixelId: process.env.META_PIXEL_ID || '',
    siteDomain: process.env.SITE_DOMAIN || 'http://localhost:3000',
  };
  const html = template(context);
  const dir = path.join(PUBLIC_DIR, leagueData.season, leagueData.slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  return path.join(dir, 'index.html');
}

// ─── Main crawl function ──────────────────────────────────────────────────────
async function crawl(onProgress) {
  const log = (msg) => {
    console.log(msg);
    if (onProgress) onProgress(msg);
  };

  log('🚀 Starting crawl of ' + SOURCE_URL);

  ensureDir(DATA_DIR);
  ensureDir(IMAGES_DIR);
  ensureDir(PUBLIC_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let leagues = [];

  try {
    // ─── Step 1: Crawl the main leagues index page ──────────────────
    log('📄 Loading main leagues page...');
    await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    leagues = await page.evaluate(() => {
      const BASE = 'https://www.midwest3on3.com';
      const results = [];
      const seen = new Set();

      // Normalise any href → absolute URL
      function toFullUrl(href) {
        if (!href) return null;
        if (href.startsWith('http')) return href;
        if (href.startsWith('//')) return 'https:' + href;
        if (href.startsWith('/')) return BASE + href;
        return BASE + '/' + href; // relative with no leading slash
      }

      // Extract slug (and fallback URL-season) from a full URL
      function parsePath(full) {
        const m = full.match(/\/leagues\/(spring|summer|fall|winter)\/([^/?#]+)/i);
        if (m) return { urlSeason: m[1].toLowerCase(), slug: m[2].toLowerCase() };
        // Edge-case: /river-falls-wi-league (outside /leagues/)
        try {
          const p = new URL(full).pathname.replace(/^\/+/, '').replace(/[/?#].*$/, '');
          return { urlSeason: null, slug: p || null };
        } catch (e) {
          return { urlSeason: null, slug: null };
        }
      }

      // Is this link a real league page?
      function isLeaguePage(full, name) {
        if (!full.includes('midwest3on3.com')) return false;
        if (!full.includes('/leagues/') && !full.match(/\/[a-z0-9-]+-league(\b|$)/i)) return false;
        if (full.match(/midwest3on3\.com\/leagues\/?$/)) return false;
        const skipNames = ['start a new league', 'learn more', 'home', 'merch', 'about', 'play', '3 on 3 hoops hub'];
        if (skipNames.some(s => name.toLowerCase().includes(s))) return false;
        return true;
      }

      const SEASON_NAMES = ['winter', 'spring', 'summer', 'fall'];

      // Strategy A: column-aware — reads season from visual column heading
      const columns = Array.from(
        document.querySelectorAll('.sqs-col-3, .span-3, [class*="col-3"]')
      );

      if (columns.length >= 3) {
        columns.forEach((col) => {
          const headingEl = col.querySelector('h1,h2,h3,h4,strong,b');
          const headingText = headingEl ? headingEl.textContent.trim().toLowerCase() : '';
          const colSeason = SEASON_NAMES.find(s => headingText.startsWith(s)) || null;

          col.querySelectorAll('a[href]').forEach(link => {
            const raw = link.getAttribute('href');
            const full = toFullUrl(raw);
            const name = link.textContent.trim().replace(/\s+/g, ' ');
            if (!full || seen.has(full) || !name) return;
            if (!isLeaguePage(full, name)) return;

            seen.add(full);
            const { urlSeason, slug } = parsePath(full);
            if (!slug) return;

            results.push({
              season: colSeason || urlSeason || 'unknown',
              slug,
              name,
              sourceUrl: full
            });
          });
        });
      }

      // Strategy B: global fallback — catches any links not in a column
      document.querySelectorAll('a[href]').forEach(link => {
        const raw = link.getAttribute('href');
        const full = toFullUrl(raw);
        const name = link.textContent.trim().replace(/\s+/g, ' ');
        if (!full || seen.has(full) || !name) return;
        if (!isLeaguePage(full, name)) return;

        seen.add(full);
        const { urlSeason, slug } = parsePath(full);
        if (!slug) return;

        results.push({
          season: urlSeason || 'unknown',
          slug,
          name,
          sourceUrl: full
        });
      });

      return results;
    });

    // Post-process: de-dup by sourceUrl, apply known season corrections
    // Some leagues have URL paths in the wrong season folder on Squarespace
    const SEASON_OVERRIDES = {
      'osseo-league':                   'summer',
      'hope-field-house-rosemount-aug': 'summer',
      'prior-lake-summer-league':       'summer',
      'river-falls-wi-league':          'fall',
    };

    const seen2 = new Set();
    leagues = leagues
      .filter(l => {
        if (seen2.has(l.sourceUrl)) return false;
        seen2.add(l.sourceUrl);
        return true;
      })
      .map(l => ({
        ...l,
        season: SEASON_OVERRIDES[l.slug] || l.season
      }));

    log(`\n✅ Found ${leagues.length} leagues on main page`);
    leagues.forEach((l, i) => log(`   ${i + 1}. [${l.season}] ${l.name}`));
    log('');

    // Load Handlebars template
    const template = loadTemplate();

    // ─── Step 2: Crawl each individual league page ───────────────────
    const results = [];
    for (let i = 0; i < leagues.length; i++) {
      const league = leagues[i];
      log(`[${i + 1}/${leagues.length}] 🏀 Crawling: ${league.name} (${league.season})`);

      try {
        await page.goto(league.sourceUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        const data = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';

          // Title
          const titleEl = document.querySelector('h1');
          const title = titleEl ? titleEl.textContent.trim() : document.title.split('|')[0].trim();

          // Edition (e.g. "18th Annual")
          const editionMatch = bodyText.match(/(\d+(?:st|nd|rd|th)\s+Annual)/i);
          const edition = editionMatch ? editionMatch[1] : '';

          // Image — first sizeable non-logo image
          let imageUrl = '';
          const imgs = Array.from(document.querySelectorAll('img[src]'));
          for (const img of imgs) {
            const src = img.src || '';
            if (src && !src.includes('logo') && !src.includes('icon') &&
                !src.includes('favicon') && (img.naturalWidth || img.width) > 80) {
              imageUrl = src;
              break;
            }
          }

          // Location — find elements with MN/WI ZIP pattern, filter CSS artifacts
          let venue = '', address = '', city = '';
          const allEls = Array.from(document.querySelectorAll('p, h3, h4, div[data-block-type]'));
          for (const el of allEls) {
            const rawText = el.innerText || '';
            if (!rawText.trim() || rawText.length > 300) continue;
            if (/\b(MN|WI)\s+\d{5}\b/.test(rawText)) {
              const lines = rawText.split('\n').map(l => l.trim())
                .filter(l => l && !l.includes('{') && !l.includes(';'));
              if (lines.length >= 1) {
                if (lines.length === 1) {
                  city = lines[0];
                } else {
                  venue = lines[0];
                  address = lines[1] || '';
                  city = lines[2] || lines[1] || '';
                }
              }
              break;
            }
          }

          // Dates
          const datesMatch = bodyText.match(/(?:(?:Dates|Dates:|Sundays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays)(?:\s*-\s*[A-Za-z]+)?\s*-?:?)\s*([A-Za-z]+\s*\d{1,2}.*?)(?=\n\n|\n\*\*|\n\*|\n[A-Z]|\nWe accept)/i);
          const dates = datesMatch ? datesMatch[1].replace(/\s+/g, ' ').trim() : '';

          // Times
          const timesMatch = bodyText.match(/(?:Approximate\s+)?Times?:?\s*([^\n]+)/i);
          const times = timesMatch ? timesMatch[1].trim() : '';

          // Eligibility
          const whoMatch = bodyText.match(/Who:?\s*([^\n]+(?:\n\s+[^\n]+)*?)(?=\n\n|\n[A-Z*])/i);
          const eligibility = whoMatch ? whoMatch[1].replace(/\s+/g, ' ').trim() : '';

          // Early Bird registration
          const earlyBirdMatch = bodyText.match(/EARLY\s+BIRD[^]*?ends[^]*?(?:at midnight\s+)?(?:on\s+)?([A-Za-z]+\s+\d+)[^]*?Cost\s*:?\s*\$?([\d,]+)(?:\/team)?/i);
          const earlyBirdDeadline = earlyBirdMatch ? earlyBirdMatch[1].trim() : '';
          const earlyBirdCost = earlyBirdMatch ? '$' + earlyBirdMatch[2] + '/team' : '';

          // Final registration
          const finalMatch = bodyText.match(/FINAL\s+Registration[^]*?ends[^]*?(?:at midnight\s+)?(?:on\s+)?([A-Za-z]+\s+\d+)[^]*?Cost\s*:?\s*\$?([\d,]+)(?:\/team)?/i);
          const finalDeadline = finalMatch ? finalMatch[1].trim() : '';
          const finalCost = finalMatch ? '$' + finalMatch[2] + '/team' : '';

          // Register Now URL (sportngin)
          let registerUrl = '';
          const regLinks = Array.from(document.querySelectorAll('a[href*="sportngin"]'));
          for (const link of regLinks) {
            registerUrl = link.getAttribute('href');
            break;
          }

          const shirtsWeek1 = /Shirts\s+will\s+arrive\s+week\s+1/i.test(bodyText);
          const shirtsWeek2 = /Shirts\s+will\s+arrive\s+week\s+2/i.test(bodyText);

          return {
            title, edition, imageUrl,
            location: { venue, address, city },
            dates, times, eligibility,
            earlyBird: { deadline: earlyBirdDeadline, cost: earlyBirdCost },
            finalReg: { deadline: finalDeadline, cost: finalCost },
            registerUrl, shirtsWeek1, shirtsWeek2,
          };
        });

        const leagueData = {
          ...league,
          ...data,
          lastUpdated: new Date().toISOString()
        };

        // Download league image
        if (leagueData.imageUrl) {
          ensureDir(path.join(IMAGES_DIR, leagueData.season));
          const imgExt = leagueData.imageUrl.split('?')[0].match(/\.(jpg|jpeg|png|webp|gif)$/i);
          const imgFilename = leagueData.slug + (imgExt ? imgExt[0] : '.jpg');
          const imgPath = path.join(IMAGES_DIR, leagueData.season, imgFilename);
          try {
            await downloadFile(leagueData.imageUrl, imgPath);
            leagueData.localImage = `/images/leagues/${leagueData.season}/${imgFilename}`;
            log(`  📸 Image saved: ${imgFilename}`);
          } catch (err) {
            log(`  ⚠️  Image download failed: ${err.message}`);
            leagueData.localImage = '';
          }
        } else {
          leagueData.localImage = '';
        }

        // Save JSON
        const seasonDataDir = path.join(DATA_DIR, leagueData.season);
        ensureDir(seasonDataDir);
        fs.writeFileSync(
          path.join(seasonDataDir, leagueData.slug + '.json'),
          JSON.stringify(leagueData, null, 2), 'utf8'
        );
        log(`  💾 data/leagues/${leagueData.season}/${leagueData.slug}.json`);

        // Generate landing page
        generateLandingPage(leagueData, template);
        log(`  🌐 public/leagues/${leagueData.season}/${leagueData.slug}/index.html`);

        results.push({ slug: leagueData.slug, season: leagueData.season, name: leagueData.name, status: 'ok', lastUpdated: leagueData.lastUpdated });

      } catch (err) {
        log(`  ❌ Error: ${err.message}`);
        results.push({ slug: league.slug, season: league.season, name: league.name, status: 'error', error: err.message });
      }

      await page.waitForTimeout(1000);
    }

    // Save master index
    fs.writeFileSync(
      path.join(DATA_DIR, 'index.json'),
      JSON.stringify({ lastUpdated: new Date().toISOString(), leagues: results }, null, 2),
      'utf8'
    );

    // Generate hub page from freshly-saved data
    generateHubPage();

    const ok = results.filter(r => r.status === 'ok').length;
    log(`\n✅ Crawl complete! ${ok}/${results.length} leagues updated`);
    return results;

  } finally {
    await browser.close();
  }
}

// Regenerate landing pages from existing JSON (no crawl)
function regenerateFromData() {
  const template = loadTemplate();
  const seasons = ['spring', 'summer', 'fall', 'winter'];
  let count = 0;
  for (const season of seasons) {
    const seasonDir = path.join(DATA_DIR, season);
    if (!fs.existsSync(seasonDir)) continue;
    fs.readdirSync(seasonDir).filter(f => f.endsWith('.json')).forEach(file => {
      const data = JSON.parse(fs.readFileSync(path.join(seasonDir, file), 'utf8'));
      generateLandingPage(data, template);
      count++;
    });
  }
  generateHubPage();
  console.log(`✅ Regenerated ${count} landing pages + hub from existing data`);
  return count;
}

module.exports = { crawl, regenerateFromData };

// Run directly: node crawler/crawl.js
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  crawl(console.log).catch(console.error);
}
