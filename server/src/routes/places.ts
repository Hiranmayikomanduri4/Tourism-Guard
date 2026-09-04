import { Router } from "express";
import { placeSearch, nearbySearch, hotelSearch, touristAttractionsSearch } from "../services/googleService.js";

const router = Router();

type Coord = [number, number];
type RoutePoint = { lat: number; lng: number };
type StationType = "fuel" | "ev_charging";

// ------------------------------------------------------------------
// Network helpers
//
// Overpass/Nominatim calls previously used a bare `fetch` with no
// timeout and a single endpoint. In production this meant one slow
// or unreachable mirror silently produced an empty result for the
// whole "along route" search (fuel stations AND tourist places),
// which is what showed up as "No filling stations found" / "No
// tourist attractions were found" even on long, well-covered routes.
// These helpers add a hard timeout and automatic fallback across
// multiple public Overpass mirrors so a single slow/blocked host
// doesn't wipe out every result.
// ------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

async function fetchWithTimeout(url: string, options: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runOverpassQuery(query: string): Promise<any[]> {
  let lastError: any;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "TourismGuardian/1.0" },
        body: new URLSearchParams({ data: query }).toString()
      }, 25000);
      if (!response.ok) throw new Error(`Overpass error ${response.status} from ${endpoint}`);
      const data: any = await response.json();
      return data.elements || [];
    } catch (e: any) {
      lastError = e;
      console.error(`[places] Overpass mirror failed (${endpoint}): ${e?.message || e}`);
      // try next mirror
    }
  }
  throw lastError || new Error("All Overpass mirrors failed");
}

function pointToSegmentKm(p: RoutePoint, a: RoutePoint, b: RoutePoint) {
  const lat0 = (p.lat * Math.PI) / 180;
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  const px = p.lng * kx, py = p.lat * ky;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function haversineKm(a: RoutePoint, b: RoutePoint) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function routeDistanceKm(p: RoutePoint, coordinates: Coord[]) {
  let best = Infinity;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = { lat: Number(coordinates[i][1]), lng: Number(coordinates[i][0]) };
    const b = { lat: Number(coordinates[i + 1][1]), lng: Number(coordinates[i + 1][0]) };
    best = Math.min(best, pointToSegmentKm(p, a, b));
  }
  return best;
}

// Distance travelled from the start of the selected route to the nearest
// route segment. This lets the UI say "25 km ahead" instead of only showing
// perpendicular distance from the road.
function distanceAlongRouteKm(p: RoutePoint, coordinates: Coord[]) {
  let travelled = 0;
  let best = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = { lat: Number(coordinates[i][1]), lng: Number(coordinates[i][0]) };
    const b = { lat: Number(coordinates[i + 1][1]), lng: Number(coordinates[i + 1][0]) };
    const lat0 = (p.lat * Math.PI) / 180;
    const kx = 111.32 * Math.cos(lat0), ky = 110.57;
    const px = p.lng * kx, py = p.lat * ky;
    const ax = a.lng * kx, ay = a.lat * ky;
    const bx = b.lng * kx, by = b.lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const d = haversineKm(p, proj);
    const segmentKm = haversineKm(a, b);
    if (d < best) {
      best = d;
      bestAlong = travelled + segmentKm * t;
    }
    travelled += segmentKm;
  }
  return bestAlong;
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function openingHoursFromTags(tags: any): string | undefined {
  return tags.opening_hours || tags["opening_hours:en"] || undefined;
}

function touristCategory(tags: any) {
  if (tags.waterway === "waterfall" || tags.natural === "waterfall") return "waterfall";
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.tourism === "museum") return "museum";
  if (tags.historic) return "historical";
  if (tags.amenity === "place_of_worship") return "temple";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  return "tourist";
}

async function overpassRouteSearch(coordinates: Coord[], mode: "fuel" | "ev_charging" | "tourist") {
  const valid = coordinates.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Number(p[0]), Number(p[1])] as Coord);
  if (valid.length < 2) return [];

  // Tourist mode issues 5 tag clauses per sample point, so it needs a
  // lower point cap than fuel/EV (1 clause per point) to keep the
  // combined Overpass query small enough to finish before it times out
  // on long routes (e.g. a multi-state trip).
  const maxSamples = mode === "tourist" ? 20 : 32;
  const samples = Math.min(maxSamples, Math.max(8, Math.ceil(valid.length / 70)));
  const points: Coord[] = [];
  for (let i = 0; i < samples; i++) points.push(valid[Math.round((i * (valid.length - 1)) / (samples - 1))]);

  const around = points.map(([lng, lat]) => {
    if (mode === "fuel") return `nwr(around:6500,${lat},${lng})[amenity=fuel];`;
    if (mode === "ev_charging") return `nwr(around:6500,${lat},${lng})[amenity=charging_station];`;
    return [
      `nwr(around:8000,${lat},${lng})[tourism~"attraction|museum|viewpoint|gallery|theme_park"];`,
      `nwr(around:8000,${lat},${lng})[historic~"monument|castle|archaeological_site|fort|ruins"];`,
      `nwr(around:8000,${lat},${lng})[natural~"waterfall|peak"];`,
      `nwr(around:8000,${lat},${lng})[amenity=place_of_worship];`,
      `nwr(around:8000,${lat},${lng})[leisure~"park|garden"];`
    ].join("\n");
  }).join("\n");

  const query = `[out:json][timeout:25];(${around});out center tags;`;
  const elements = await runOverpassQuery(query);

  return elements.map((el: any) => {
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    const tags = el.tags || {};
    const name = tags.name || tags["name:en"] || tags.operator || (mode === "fuel" ? "Fuel station" : mode === "ev_charging" ? "EV charging station" : "Tourist place");
    const point = { lat, lng };
    return {
      id: `overpass-${mode}-${el.type}-${el.id}`,
      displayName: { text: name },
      formattedAddress: [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"], tags["addr:state"]].filter(Boolean).join(", ") || name,
      location: { latitude: lat, longitude: lng },
      category: mode === "tourist" ? touristCategory(tags) : mode,
      openingHours: openingHoursFromTags(tags),
      _routeDistanceKm: routeDistanceKm(point, valid),
      _distanceAlongRouteKm: distanceAlongRouteKm(point, valid),
      operator: tags.operator
    };
  }).filter((p: any) => Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude));
}

// ------------------------------------------------------------------
// OpenTripMap route search
//
// The public Overpass mirrors above are frequently rate-limited (429),
// slow (504), or unreachable ("fetch failed") in production, which was
// silently emptying "along route" tourist results. OpenTripMap is a
// single authenticated HTTPS endpoint built specifically for
// sightseeing data, so it's used here as a reliable primary source;
// Overpass/Nominatim results (when they do come through) are merged
// in on top rather than relied on alone.
// ------------------------------------------------------------------

function sampleRoutePoints(valid: Coord[], maxSamples: number, minSamples: number) {
  const samples = Math.min(maxSamples, Math.max(minSamples, Math.ceil(valid.length / 70)));
  const points: Coord[] = [];
  for (let i = 0; i < samples; i++) points.push(valid[Math.round((i * (valid.length - 1)) / (samples - 1))]);
  return points;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

async function openTripMapRouteSearch(valid: Coord[]) {
  if (!process.env.OPENTRIPMAP_API_KEY) return [];

  const points = sampleRoutePoints(valid, 20, 8);
  const perPoint = await mapWithConcurrency(points, 5, async ([lng, lat]) => {
    try {
      const { places } = await touristAttractionsSearch(lat, lng, 8000, "interesting_places");
      return places || [];
    } catch (e: any) {
      console.error(`[places] OpenTripMap point search failed: ${e?.message || e}`);
      return [];
    }
  });

  return perPoint.flat()
    .filter((p: any) => p?.location && Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude))
    .map((p: any) => {
      const point = { lat: Number(p.location.latitude), lng: Number(p.location.longitude) };
      return {
        ...p,
        category: p.category || "tourist",
        _routeDistanceKm: routeDistanceKm(point, valid),
        _distanceAlongRouteKm: distanceAlongRouteKm(point, valid)
      };
    });
}

router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ message: "Search query required" });
    const lat = req.query.lat ? Number(req.query.lat) : undefined;
    const lng = req.query.lng ? Number(req.query.lng) : undefined;
    res.json(await placeSearch(q, lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Live places unavailable", detail: e.message }); }
});

router.get("/nearby", async (req, res) => {
  try {
    const q = String(req.query.type || "").trim();
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!q || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "type, lat and lng are required" });
    res.json(await nearbySearch(q, lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Live places unavailable", detail: e.message }); }
});

router.get("/hotels", async (req, res) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "lat and lng are required" });
    res.json(await hotelSearch(lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Hotel search unavailable", detail: e.message }); }
});

router.get("/destination-attractions", async (req, res) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "lat and lng are required" });
    if (process.env.OPENTRIPMAP_API_KEY) {
      const result = await touristAttractionsSearch(lat, lng);
      if (result.places?.length) return res.json(result);
    }
    res.json(await nearbySearch("tourist attractions", lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Destination attractions unavailable", detail: e.message }); }
});

async function nominatimRouteSearch(valid: Coord[], type: "fuel" | "ev_charging") {
  const lngs = valid.map((p) => p[0]), lats = valid.map((p) => p[1]);
  const bbox = {
    south: Math.max(-90, Math.min(...lats) - 0.08), north: Math.min(90, Math.max(...lats) + 0.08),
    west: Math.max(-180, Math.min(...lngs) - 0.08), east: Math.min(180, Math.max(...lngs) + 0.08)
  };
  const q = type === "fuel" ? "petrol station" : "EV charging station";
  // bounded:1 keeps results inside the route's own bounding box instead
  // of letting Nominatim rank by global "importance" (which fuel/EV
  // points almost never have, so bounded:0 effectively returned nothing
  // useful once the route-distance filter discarded far-away matches).
  const params = new URLSearchParams({ q, format: "json", addressdetails: "1", limit: "50", countrycodes: "in", viewbox: `${bbox.west},${bbox.north},${bbox.east},${bbox.south}`, bounded: "1" });
  let response;
  try {
    response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?${params.toString()}`, { headers: { "User-Agent": "TourismGuardian/1.0" } }, 15000);
  } catch (e: any) {
    console.error(`[places] Nominatim request failed: ${e?.message || e}`);
    return [];
  }
  if (!response.ok) { console.error(`[places] Nominatim error ${response.status}`); return []; }
  const data: any[] = await response.json();
  return data.map((place: any) => {
    const lat = Number(place.lat), lng = Number(place.lon), point = { lat, lng };
    return {
      id: `nominatim-${type}-${place.place_id}`,
      displayName: { text: place.display_name?.split(",")[0] || (type === "fuel" ? "Fuel station" : "EV charging station") },
      formattedAddress: place.display_name || "",
      location: { latitude: lat, longitude: lng },
      category: type,
      _routeDistanceKm: routeDistanceKm(point, valid),
      _distanceAlongRouteKm: distanceAlongRouteKm(point, valid)
    };
  }).filter((p: any) => Number.isFinite(p._routeDistanceKm));
}

async function stationsAlongRoute(valid: Coord[], type: StationType) {
  const [osm, overpass] = await Promise.allSettled([nominatimRouteSearch(valid, type), overpassRouteSearch(valid, type)]);
  if (overpass.status === "rejected") console.error(`[places] Overpass ${type} search failed: ${overpass.reason?.message || overpass.reason}`);
  const all = [
    ...(osm.status === "fulfilled" ? osm.value : []),
    ...(overpass.status === "fulfilled" ? overpass.value : [])
  ].filter((p: any) => p._routeDistanceKm <= 5);

  const unique = new Map<string, any>();
  for (const p of all) {
    const nameKey = normalizeName(p.displayName?.text || "");
    const coordKey = `${Number(p.location.latitude).toFixed(5)},${Number(p.location.longitude).toFixed(5)}`;
    const key = `${nameKey}|${coordKey}`;
    if (!unique.has(key)) unique.set(key, p);
  }
  return Array.from(unique.values()).sort((a, b) => (a._distanceAlongRouteKm ?? Infinity) - (b._distanceAlongRouteKm ?? Infinity)).slice(0, 40);
}

router.post("/along-route", async (req, res) => {
  try {
    const coordinates = req.body?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return res.status(400).json({ message: "Route geometry is required" });
    const valid: Coord[] = coordinates.filter((p: any) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p: any) => [Number(p[0]), Number(p[1])] as Coord);
    if (valid.length < 2) return res.status(400).json({ message: "Valid route geometry is required" });

    const requested: StationType[] = Array.isArray(req.body?.types)
      ? req.body.types.filter((t: any): t is StationType => t === "fuel" || t === "ev_charging")
      : ["fuel", "ev_charging"];
    const types: StationType[] = requested.length
  ? Array.from(new Set(requested))
  : ["fuel", "ev_charging"];
    const results = await Promise.all(types.map((type) => stationsAlongRoute(valid, type)));
    const places = results.flat().sort((a, b) => (a._distanceAlongRouteKm ?? Infinity) - (b._distanceAlongRouteKm ?? Infinity));
    res.json({ places });
  } catch (e: any) { res.status(502).json({ message: "Fuel/EV station search unavailable", detail: e.message }); }
});

router.post("/along-route-attractions", async (req, res) => {
  try {
    const coordinates = req.body?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return res.status(400).json({ message: "Route geometry is required" });
    const valid: Coord[] = coordinates.filter((p: any) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p: any) => [Number(p[0]), Number(p[1])] as Coord);
    if (valid.length < 2) return res.status(400).json({ message: "Valid route geometry is required" });

    // Anchor the supplementary Google/Nominatim text search to the
    // route's midpoint. Without a lat/lng bias this was a completely
    // unanchored global text search ("tourist attractions along the
    // route" with no location) that Google/Nominatim can't meaningfully
    // answer, so it never contributed real results.
    const midpoint = valid[Math.floor(valid.length / 2)];
    const midLat = midpoint[1], midLng = midpoint[0];

    const [overpass, openTripMap, broadSearches] = await Promise.allSettled([
      overpassRouteSearch(valid, "tourist"),
      openTripMapRouteSearch(valid),
      Promise.all([
        placeSearch("tourist attractions", midLat, midLng),
        placeSearch("waterfalls viewpoints museums temples historical places", midLat, midLng)
      ])
    ]);

    if (overpass.status === "rejected") console.error(`[places] Overpass tourist search failed: ${overpass.reason?.message || overpass.reason}`);
    if (openTripMap.status === "rejected") console.error(`[places] OpenTripMap tourist search failed: ${openTripMap.reason?.message || openTripMap.reason}`);
    const found: any[] = [
      ...(overpass.status === "fulfilled" ? overpass.value : []),
      ...(openTripMap.status === "fulfilled" ? openTripMap.value : [])
    ];
    if (broadSearches.status === "fulfilled") {
      for (const result of broadSearches.value as any[]) {
        for (const p of result.places || []) {
          if (!p.location) continue;
          const point = { lat: Number(p.location.latitude), lng: Number(p.location.longitude) };
          const routeD = routeDistanceKm(point, valid);
          if (!Number.isFinite(routeD) || routeD > 8) continue;
          found.push({
            ...p,
            category: "tourist",
            _routeDistanceKm: routeD,
            _distanceAlongRouteKm: distanceAlongRouteKm(point, valid)
          });
        }
      }
    }

    const unique = new Map<string, any>();
    for (const p of found) {
      if ((p._routeDistanceKm ?? Infinity) > 8) continue;
      const nameKey = normalizeName(p.displayName?.text || "");
      const coordKey = `${Number(p.location.latitude).toFixed(5)},${Number(p.location.longitude).toFixed(5)}`;
      const key = p.id ? `id:${p.id}` : `${nameKey}|${coordKey}`;
      const previous = unique.get(key);
      if (!previous || (p._routeDistanceKm ?? Infinity) < (previous._routeDistanceKm ?? Infinity)) unique.set(key, p);
    }

    const places = Array.from(unique.values())
      .sort((a, b) => (a._distanceAlongRouteKm ?? Infinity) - (b._distanceAlongRouteKm ?? Infinity))
      .slice(0, 50);
    res.json({ places });
  } catch (e: any) { res.status(502).json({ message: "Route attractions unavailable", detail: e.message }); }
});

export default router;
