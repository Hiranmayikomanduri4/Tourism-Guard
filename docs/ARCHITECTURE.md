# Architecture and explanation

## Frontend
React pages provide the tourist and authority experiences. Zustand stores authentication. TanStack Query is installed for later caching/query expansion. The current starter uses Axios for concise API calls.

## Backend
Express exposes REST endpoints. MongoDB stores users, journeys and emergency events. Socket.IO broadcasts new/updated emergency events to the authority room.

## Live location
The browser's Geolocation API is the source of truth. `watchPosition` is started by the tourist page. The backend only receives journey location updates when a journey is active and the user has explicitly consented.

## Maps
The browser loads Google Maps JavaScript API. Server-side Places and Routes calls keep the server API key away from the browser. The browser key must be restricted by HTTP referrer.

## Safety
`vulnerabilityEngine.ts` is intentionally deterministic. It can consume real signals from weather, traffic, geofencing, battery, network and device sensors. It never asks AI to declare an accident.

## AI
Gemini should be added as an interpretation layer only. It must receive retrieved real data and must never invent live facts.

## Provider limits
Google Places does not itself guarantee live room prices. Google Maps does not magically provide every public transport operator's real-time availability. Add real provider adapters only when a provider is available. Until then, display unavailable rather than fake data.

## Production hardening
Before deployment: restrict API keys, implement invitation-based authority creation, encrypt sensitive data where required, add notification providers, audit all authority access, add formal consent records, test sensor thresholds on target devices, and configure official restricted-zone datasets.
