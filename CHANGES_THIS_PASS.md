# Changes in this pass

## 1. Source/Destination input visibility — FIXED
- Removed the fragile `input[value="..."]` / `input[placeholder*="..."]` CSS hack in `styles.css` (it only matched the initial HTML attribute, not the live React value — the root cause of the blank/white boxes).
- Added real classes: `.route-location-field`, `.route-location-input`, `.source-input`, `.destination-input`, `.location-suggestions`, `.location-suggestion-item` with explicit background/color for default, hover, focus and disabled states.
- Added location icons inside each field and a swap (⇅) button (`swapSourceDestination()` in `Home.tsx`) between Source and Destination.

## 2/4. Nearby places along the route — PARTIALLY DONE
- Added a route summary (Source → Destination, distance, duration) and a proper "select a route first" empty state to the Nearby screen.
- The existing `/places/along-route-attractions` corridor search (Nominatim + Overpass fallback) was kept and is now tagged with `category: "tourist"` for consistent map markers.
- NOT done: full two-column redesign (scrollable cards + large map side-by-side), marker↔card highlight sync, "Add to Trip"/detour-time UI. The data plumbing is in place; this is now a frontend layout task.

## 3. Filling stations = Petrol + EV — DONE
- `POST /places/along-route` now accepts `{ coordinates, types: ["fuel","ev_charging"] }`, queries both via Nominatim with an Overpass fallback, and returns each place tagged `category: "fuel" | "ev_charging"`.
- Added `[All] [Petrol/Diesel] [EV Charging]` filter tabs on the Filling Stations screen, distinct ⛽/⚡ badges and map markers (new `.ev` marker color in `MapView.tsx`), and clear empty/loading states per type.

## 5/6/7. Trip planner repeating days — FIXED (the core bug)
- Removed the modulo cycling (`arakuPlan[d % arakuPlan.length]`, `places.slice(d*3, d*3+3)` with no dedupe) that caused places to repeat after day 3.
- `planner.ts` now builds a deduplicated pool of real places across categories (nature, waterfalls, viewpoints, culture, history, museums, markets, adventure), pulled from live search plus a curated Araku seed list (merged into the pool, not cycled), and distributes them round-robin across days so consecutive days don't repeat the same category. A place is only reused as an explicit last resort and is flagged `isRevisit: true`.
- Supports 1–7 days as required.

## 8/9. Budget-aware planning + daily schedule — DONE (backend)
- `/planner/itinerary` now accepts `budget` and returns a `budget` object: tier (low/medium/high), per-day estimate, and an estimated breakdown (accommodation, food, local transport, sightseeing, fuel/EV, misc), all labelled as estimates.
- Each day now includes morning/afternoon/evening slots with times, a lunch block, a stay suggestion, a transport suggestion, an estimated daily cost, and a safety tip. The last day of a multi-day trip is automatically lighter (1 stop + return-journey framing).
- NOT done: the frontend Trip Planner UI (day tabs, ₹ header, included/excluded checklist) still needs to be updated to render these new fields — the API shape changed, so the existing render code should be checked against the new response before shipping.

## Not attempted this pass (flagged, not silently skipped)
- Full visual re-theme of every screen to match the reference screenshots (Trip Packages screen, Journey screen marker set, Route screen risk cards) — CSS variables and card patterns are already close to the reference; a full pass would touch most of `styles.css` and `Home.tsx`.
- Frontend rendering for the new itinerary response shape (day tabs, budget breakdown UI).
- Full responsive/mobile audit (item 18) and the complete acceptance test pass (item 20) — recommend running `npm run build` for both `client` and `server` after `npm install`, since this sandbox has no network access to install dependencies and run a live build.
