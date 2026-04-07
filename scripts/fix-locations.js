'use strict';
/**
 * Fix location data in existing JSON files — strips CSS artifacts
 * Run once: node scripts/fix-locations.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { regenerateFromData } = require('../crawler/crawl');

const DATA_DIR = path.join(__dirname, '..', 'data', 'leagues');
const seasons = ['spring', 'summer', 'fall', 'winter'];

function cleanCss(str) {
  if (!str) return str;
  // Remove CSS class patterns like ".fe-block-xxx { ... }"
  return str
    .replace(/\.fe-block[\w-]+\s*\{[^}]*\}/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/;\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function fixJson(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let changed = false;

  if (data.location) {
    const before = JSON.stringify(data.location);
    data.location.venue = cleanCss(data.location.venue);
    data.location.address = cleanCss(data.location.address);
    data.location.city = cleanCss(data.location.city);
    if (JSON.stringify(data.location) !== before) changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Fixed: ${path.relative(process.cwd(), filePath)}`);
  }
  return changed;
}

let total = 0, fixed = 0;

for (const season of seasons) {
  const seasonDir = path.join(DATA_DIR, season);
  if (!fs.existsSync(seasonDir)) continue;
  const files = fs.readdirSync(seasonDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    total++;
    if (fixJson(path.join(seasonDir, file))) fixed++;
  }
}

console.log(`\n✅ Checked ${total} files, fixed ${fixed} with CSS artifacts.`);

// Regenerate all landing pages from cleaned data
console.log('🔄 Regenerating landing pages...');
regenerateFromData();
