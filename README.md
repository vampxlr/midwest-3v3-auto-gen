# Midwest 3v3 Landing Page Generator

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # edit .env with your real values
node server.js
```

Visit `http://localhost:3000` to see the leagues index.
Visit `http://localhost:3000/portal` to access the admin portal.

## Project Structure

```
3v3-landing-page/
├── .env                      # Config: PIN, GTM ID, Pixel ID, CAPI token
├── server.js                 # Express server
├── crawler/
│   └── crawl.js              # Playwright crawler
├── data/
│   └── leagues/              # JSON data per league
├── images/
│   └── leagues/              # Mirrored league images
├── public/
│   ├── leagues/              # Generated landing pages
│   ├── portal/               # Admin portal UI
│   └── assets/               # Shared CSS/JS
└── templates/
    └── league-landing.hbs    # Handlebars landing page template
```

## Usage

1. Open `http://localhost:3000/portal`
2. Enter your PIN (default: `1234`)
3. Click **Update All Leagues** to crawl Midwest 3v3 and regenerate all landing pages
4. Landing pages are live at `http://localhost:3000/leagues/[season]/[slug]`

## Tracking

- **GTM**: Set `GTM_CONTAINER_ID` in `.env`
- **Meta Pixel**: Set `META_PIXEL_ID` in `.env`
- **Meta CAPI**: Set `META_CAPI_ACCESS_TOKEN` in `.env`

Events fired on each landing page load:
- GTM: PageView (via GTM container)
- Meta Pixel: `PageView`
- Meta CAPI (server-side): `PageView` event sent to Meta Conversions API

## Facebook Ads

Point each ad's landing page URL to the specific league page, e.g.:
`https://yourdomain.com/leagues/spring/blaine`
