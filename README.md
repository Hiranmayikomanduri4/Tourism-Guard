# 🛡️ Tourism Guardian
Explore Freely. Travel Safely.

A real-time tourist safety platform built around consented device GPS, Google Maps Platform, real weather data, Socket.IO emergency events, MongoDB, and a calculated safety/vulnerability engine.

## What is live
- Device geolocation uses `watchPosition()` only while the app is open; Journey Mode sends consented updates to the backend. Browser geolocation requires permission and a secure context (HTTPS in deployment).
- Google Places (New): real place IDs, addresses, ratings/availability fields when returned, phone and website fields when available.
- Google Routes API: traffic-aware routes and alternatives where Google returns them.
- Google Roads API: nearest-road metadata. Roads API does not itself provide a general road-condition feed.
- Weather: OpenWeather current conditions.
- Socket.IO: real emergency events from authenticated users to authenticated authority users.
- Battery/network: real browser signals where supported.
- Fall/impact: local device-motion heuristic; it is explicitly a possible impact signal, never an accident confirmation.

## Live-data boundaries
Hotel nightly prices and bus/train live availability are **not fabricated**. Google Places can provide place/business information and price levels, but a real nightly room-price provider is required for live room rates. A genuine transport provider API is required for live bus/train availability. Until those providers are configured, the UI reports that live data is unavailable.

## Setup
1. Create a MongoDB database.
2. Create a Google Cloud project and enable the Maps JavaScript API, Places API (New), Routes API and Roads API. Routes API requires an API key and billing setup. See the official Google documentation.
3. Create a weather provider API key.
4. Copy `server/.env.example` to `server/.env` and `client/.env.example` to `client/.env`.
5. Use separate restricted browser/server keys where appropriate. Never commit secrets.
6. From the repository root run `npm install`, then `npm run install:all` and `npm run dev`.

## Security
- JWT authentication
- bcrypt password hashing
- Zod validation
- Helmet
- CORS
- rate limiting
- authority-only Socket.IO room
- server-side Google service key
- authority registration requires a server-side invite code

## Emergency escalation
Guardian Handshake is event-based. A possible impact can open a 15-second local confirmation. If the user does not respond, the backend creates a `UNRESPONSIVE_HANDSHAKE` event and broadcasts it to authorized authority clients. Trusted-contact notification uses the optional `TRUSTED_CONTACT_WEBHOOK_URL`; no fake notification is claimed when it is not configured.

## Important browser limitations
Battery Status API and Network Information API are not available in every browser. Device motion permissions/behavior vary by browser and OS. The app reports unavailable status instead of inventing values.


## Updated travel flow

1. After login, choose a Source using either **Use My Current Location** (browser GPS permission) or a searched place.
2. Search and select a Destination.
3. The app opens the route page. Start a consented journey to enable live tracking and route safety mode.
4. Journey mode calculates available OSRM alternative routes and gives each route a safety score plus a transparent next-30-minute heuristic prediction based on currently available weather/restricted-zone signals.
5. Select a route card; the map shows only that selected route.
6. Filling stations along the selected route are shown on the map during the journey.
7. Hospitals, hotels, police stations and transport can be searched around either the tourist's current location or the selected destination.
8. Famous/local tourist attractions near the destination are shown. Selecting one calculates alternative routes and safety scores to that attraction.
9. SOS requests a fresh GPS position and sends the tourist's coordinates, safety context, selected language and translated emergency message to the authority dashboard.
10. Voice search uses the browser's Speech Recognition API when available.
11. English, Telugu, Hindi and Tamil are available from the language selector.

### Safety-data transparency

The public OSRM service does not provide live traffic congestion. The route score therefore does **not** pretend to contain live traffic data. Likewise, the project currently has no verified scam/pickpocket/harassment incident feed, so those incidents are not fabricated. The predictive indicator is a heuristic using the project's configured safety signals (weather, restricted zones and route factors). A verified incident provider can be added later without changing the user workflow.

## Deployment pass (this update)

### What changed
- **Search reliability**: `/places/search` now shares the same throttled/
  retried/timeout-bounded Nominatim path as nearby search, plus a 60s
  result cache, so repeated searches on the same page no longer 429.
- **Nearby hospitals/hotels**: added to the same Google → Overpass →
  bounded-Nominatim fallback chain already used for police/train/bus, so
  "No results found nearby" should no longer happen when live data exists.
- **Nearby place clicks no longer navigate away**: tapping a hospital,
  hotel, fuel station or tourist attraction result now opens a small
  floating "route preview" panel on the *current* screen instead of
  jumping to the Destination screen. The panel has an explicit
  **"Set as Destination"** button for when that's actually what you want.
- **Trip Planner day distribution**: replaced the hardcoded "3 places for
  every day except the last (always 2)" logic with the balanced
  floor/remainder algorithm (max difference of 1 place between any two
  days; a day is only ever empty if there genuinely aren't enough unique
  live attractions for every day).
- **Trip Planner screen no longer shows the Nearby hospitals/police/
  hotels/transport UI** — that content is now scoped to the Route/
  Destination screen only; the Planner screen shows only the
  destination summary, days/budget form and generated itinerary.
- **Removed a hardcoded API-key-shaped string** that was sitting unused
  in `server/src/server.ts`.
- **CORS**: `CLIENT_URL` now accepts a comma-separated list of origins
  (and an optional `*` wildcard segment, e.g. `https://*.vercel.app`),
  so Vercel production + preview URLs + local dev can all work without
  needing `*` for a credentials-enabled API.
- **`GOOGLE_MAPS_API_KEY` is now optional** — every feature that can use
  it already has an OpenStreetMap/Overpass fallback, so the server no
  longer refuses to start without it.

### Environment variables
See `server/.env.example` and `client/.env.example` for the full,
documented list. Notably:
- `CLIENT_URL` — one origin, or comma-separated, e.g.
  `https://your-app.vercel.app,http://localhost:5173`
- `GOOGLE_MAPS_API_KEY` / `OPENTRIPMAP_API_KEY` — both optional; the app
  degrades to OpenStreetMap/Overpass-based search when unset.

### Build verification actually performed
- `cd server && npm run build` → **passed, 0 TypeScript errors**,
  `server/dist/server.js` produced.
- `cd client && npx tsc -b` → **passed, 0 TypeScript errors**.
- `cd client && npx vite build` → **could not be completed in the
  sandbox this update was prepared in**: the bundled `node_modules`
  is missing the platform-specific `@rollup/rollup-linux-x64-gnu`
  optional binary, and that sandbox has no network access to fetch it
  (a known npm optional-dependency issue, unrelated to the source
  changes above). Run `npm install` in your own environment before
  `npm run build` — that regenerates the correct binary for your
  platform and the Vite build should complete normally.

### Not attempted this pass
- A full visual/responsive redesign of the Destination/Places/Fuel
  screens — only the specific bugs above were fixed, per "modify only
  what is required."
