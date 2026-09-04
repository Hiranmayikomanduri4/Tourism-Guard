const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search";

const OSRM_URL =
  "https://router.project-osrm.org/route/v1/driving";

const OPENTRIPMAP_URL =
  "https://api.opentripmap.com/0.1/en/places";

const OVERPASS_URL =
  "https://overpass-api.de/api/interpreter";

// ============================================================
// LIVE PLACE SEARCH - OPENSTREETMAP / NOMINATIM
// ============================================================

// Short-lived cache + serialised/retried fetch for the free-text search
// endpoint. Nominatim's usage policy caps requests at ~1/second and
// rejects concurrent requests with a 429; when the frontend fires a
// search on every keystroke (or the user searches several places back
// to back on the same page) those requests were racing each other
// un-throttled, which is why "search sometimes works once, then fails".
// This reuses the same queue/backoff pattern already used for nearby
// search below, plus a short TTL cache for repeated identical queries.
const placeSearchCache = new Map<string, { at: number; result: { places: any[] } }>();
const PLACE_SEARCH_CACHE_TTL_MS = 60 * 1000;

async function fetchWithTimeout(url: string, options: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function throttledNominatimTextSearch(params: URLSearchParams) {
  let response: Response | undefined;
  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await withNominatimThrottle(() =>
        fetchWithTimeout(`${NOMINATIM_URL}?${params.toString()}`, {
          headers: { "User-Agent": "TourismGuardian/1.0" }
        }, 10000)
      );
      if (response.ok) return response;
      lastError = new Error(`OpenStreetMap search error ${response.status}`);
      if (response.status !== 429 && response.status < 500) break; // don't retry on a plain 4xx
    } catch (e: any) {
      lastError = e;
      response = undefined;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
  }
  throw lastError || new Error("OpenStreetMap search failed");
}

export async function placeSearch(
  text: string,
  lat?: number,
  lng?: number
) {
  const cacheKey = `${text.trim().toLowerCase()}|${lat ?? ""},${lng ?? ""}`;
  const cached = placeSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PLACE_SEARCH_CACHE_TTL_MS) return cached.result;

  // Prefer configured Google Places for richer data; keep OSM as a
  // resilient fallback when the Google service is unavailable.
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key && key !== "your_server_side_google_maps_key") {
    try {
      const body: any = {
        textQuery: text,
        languageCode: "en",
        regionCode: "IN",
        maxResultCount: 20
      };
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        body.locationBias = {
          circle: {
            center: { latitude: Number(lat), longitude: Number(lng) },
            radius: 50000
          }
        };
      }
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": [
            "places.id", "places.displayName", "places.formattedAddress",
            "places.location", "places.rating", "places.currentOpeningHours",
            "places.nationalPhoneNumber", "places.websiteUri", "places.priceLevel",
            "places.types"
          ].join(",")
        },
        body: JSON.stringify(body)
      });
      if (response.ok) {
        const data: any = await response.json();
        const places = (data.places || []).map((place: any) => ({
          id: place.id,
          displayName: { text: place.displayName?.text || "Unknown place" },
          formattedAddress: place.formattedAddress || "",
          location: place.location ? { latitude: Number(place.location.latitude), longitude: Number(place.location.longitude) } : undefined,
          rating: place.rating,
          currentOpeningHours: place.currentOpeningHours,
          photos: place.photos || [],
          nationalPhoneNumber: place.nationalPhoneNumber,
          websiteUri: place.websiteUri,
          priceLevel: place.priceLevel,
          types: place.types || []
        }));
        if (places.length) {
          const result = { places };
          placeSearchCache.set(cacheKey, { at: Date.now(), result });
          return result;
        }
      }
    } catch {
      // Fall through to OSM/Nominatim.
    }
  }

  const params = new URLSearchParams({
    q: text, format: "json", addressdetails: "1", limit: "20", countrycodes: "in"
  });
  if (lat !== undefined && lng !== undefined) {
    params.set("viewbox", `${lng - 1},${lat + 1},${lng + 1},${lat - 1}`);
    params.set("bounded", "0");
  }

  const response = await throttledNominatimTextSearch(params);
  const data: any[] = await response.json();
  const result = {
    places: data.map((place) => ({
      id: place.place_id?.toString(),
      displayName: { text: place.display_name?.split(",")[0] || "Unknown place" },
      formattedAddress: place.display_name || "",
      location: { latitude: Number(place.lat), longitude: Number(place.lon) },
      rating: undefined, currentOpeningHours: undefined, photos: [],
      nationalPhoneNumber: undefined, websiteUri: undefined, priceLevel: undefined,
      types: place.type ? [place.type] : []
    }))
  };
  if (result.places.length) placeSearchCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

// ============================================================
// NEARBY SEARCH
// ============================================================
//
// Police stations, railway stations and bus stands are frequently
// missing from Google/Nominatim's plain free-text search near a
// point — they aren't reliably indexed under literal words like
// "police station"/"railway station" the way "hospital"/"hotel"
// usually are. For those three types, this uses Google's Places API
// "searchNearby" with the exact Google place type (police/
// train_station/transit_station/bus_station) instead of a text
// guess — the same places.googleapis.com endpoint already used
// (and already working) for hospital/hotel — so it's precise and
// doesn't depend on any extra third-party service.
//
// When no Google key is configured (or Google returns nothing), we
// fall back to Overpass API — a tag-based query engine built exactly
// for "find amenity=police / railway=station / amenity=bus_station
// around this point" lookups. This is far more reliable than
// Nominatim's free-text search for these three categories, since it
// matches on OSM tags rather than on indexed name text. Nominatim
// bounded search remains as a last-resort fallback after that.
// ============================================================

const NEARBY_GOOGLE_TYPES: Record<string, string[]> = {
  police: ["police"],
  train_station: ["train_station", "transit_station"],
  bus_station: ["bus_station"],
  hospital: ["hospital"],
  hotel: ["lodging"]
};

async function googleTypeNearbySearch(
  includedTypes: string[],
  lat: number,
  lng: number,
  radiusMeters = 20000
) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || key === "your_server_side_google_maps_key") return [];
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": [
          "places.id", "places.displayName", "places.formattedAddress",
          "places.location", "places.rating", "places.currentOpeningHours",
          "places.nationalPhoneNumber", "places.websiteUri", "places.types"
        ].join(",")
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount: 20,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters }
        }
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[places] Google searchNearby error ${response.status} for [${includedTypes.join(",")}]: ${body.slice(0, 300)}`);
      return [];
    }
    const data: any = await response.json();
    return (data.places || [])
      .map((place: any) => ({
        id: place.id,
        displayName: { text: place.displayName?.text || "Unknown place" },
        formattedAddress: place.formattedAddress || "",
        location: place.location ? { latitude: Number(place.location.latitude), longitude: Number(place.location.longitude) } : undefined,
        rating: place.rating,
        currentOpeningHours: place.currentOpeningHours,
        photos: place.photos || [],
        nationalPhoneNumber: place.nationalPhoneNumber,
        websiteUri: place.websiteUri,
        priceLevel: undefined,
        types: place.types || []
      }))
      .filter((p: any) => p.location && Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude));
  } catch (e: any) {
    console.error(`[places] Google searchNearby request failed for [${includedTypes.join(",")}]: ${e?.message || e}`);
    return [];
  }
}

// ------------------------------------------------------------
// Overpass API — tag-based nearby search for police / railway /
// bus stations. Used as the primary fallback when Google isn't
// configured or returns nothing.
// ------------------------------------------------------------

const OVERPASS_NEARBY_QUERY: Record<string, string> = {
  police: `node["amenity"="police"](around:RADIUS,LAT,LNG);way["amenity"="police"](around:RADIUS,LAT,LNG);`,
  train_station: `node["railway"="station"](around:RADIUS,LAT,LNG);node["railway"="halt"](around:RADIUS,LAT,LNG);`,
  bus_station: `node["amenity"="bus_station"](around:RADIUS,LAT,LNG);node["highway"="bus_stop"](around:RADIUS,LAT,LNG);`,
  hospital: `node["amenity"="hospital"](around:RADIUS,LAT,LNG);way["amenity"="hospital"](around:RADIUS,LAT,LNG);`,
  hotel: `node["tourism"="hotel"](around:RADIUS,LAT,LNG);node["tourism"="guest_house"](around:RADIUS,LAT,LNG);way["tourism"="hotel"](around:RADIUS,LAT,LNG);`
};

async function overpassNearbySearch(
  text: string,
  lat: number,
  lng: number,
  radiusMeters = 20000
) {
  const template = OVERPASS_NEARBY_QUERY[text];
  if (!template) return [];

  const clause = template
    .replace(/RADIUS/g, String(radiusMeters))
    .replace(/LAT/g, String(lat))
    .replace(/LNG/g, String(lng));
  const query = `[out:json][timeout:25];(${clause});out center 20;`;

  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[places] Overpass nearby "${text}" error ${response.status}: ${body.slice(0, 300)}`);
      return [];
    }
    const data: any = await response.json();
    return (data.elements || [])
      .map((el: any) => {
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;
        if (!Number.isFinite(elLat) || !Number.isFinite(elLng)) return null;
        const fallbackName =
          text === "police" ? "Police Station" :
          text === "train_station" ? "Railway Station" :
          text === "hospital" ? "Hospital" :
          text === "hotel" ? "Hotel" : "Bus Station";
        return {
          id: `osm-${el.type}-${el.id}`,
          displayName: { text: el.tags?.name || fallbackName },
          formattedAddress: [el.tags?.["addr:street"], el.tags?.["addr:city"]].filter(Boolean).join(", "),
          location: { latitude: elLat, longitude: elLng },
          rating: undefined, currentOpeningHours: undefined, photos: [] as any[],
          nationalPhoneNumber: el.tags?.phone, websiteUri: el.tags?.website, priceLevel: undefined,
          types: [text]
        };
      })
      .filter(Boolean);
  } catch (e: any) {
    console.error(`[places] Overpass nearby "${text}" request failed: ${e?.message || e}`);
    return [];
  }
}

const NEARBY_BOUNDED_NOMINATIM_TYPES = new Set(["police", "train_station", "bus_station", "hospital", "hotel"]);

// Nominatim's usage policy caps requests at 1/second and forbids
// concurrent requests, and this app's own route-planning features
// (fuel/EV/tourist "along route" search) can already be hammering it
// at the same time from elsewhere in the app. The dedicated
// police/transport screens also fire a request for the source AND
// the destination at (almost) the same moment. Both together were
// tripping Nominatim's rate limit — it then returns 429 (looking
// like "not found" in the UI) instead of real data. This queue
// serialises every bounded nearby-search call with a >1.5s gap, and
// each call retries a few times with backoff, so it survives bursts
// of unrelated Nominatim traffic elsewhere in the app. A short-lived
// cache also avoids repeating the exact same lookup (e.g. re-opening
// the same screen for the same trip) within a few minutes.
let nominatimQueueTail: Promise<void> = Promise.resolve();
function withNominatimThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const runAfter = nominatimQueueTail;
  let release!: () => void;
  nominatimQueueTail = new Promise((resolve) => { release = resolve; });
  return runAfter.then(fn).finally(() => setTimeout(release, 1500));
}

const nominatimNearbyCache = new Map<string, { at: number; places: any[] }>();
const NOMINATIM_CACHE_TTL_MS = 5 * 60 * 1000;

async function nominatimBoundedNearbySearch(
  query: string,
  lat: number,
  lng: number,
  radiusDeg = 0.4
) {
  const cacheKey = `${query}|${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = nominatimNearbyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < NOMINATIM_CACHE_TTL_MS) return cached.places;

  const bbox = {
    south: Math.max(-90, lat - radiusDeg),
    north: Math.min(90, lat + radiusDeg),
    west: Math.max(-180, lng - radiusDeg),
    east: Math.min(180, lng + radiusDeg)
  };
  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    limit: "20",
    countrycodes: "in",
    viewbox: `${bbox.west},${bbox.north},${bbox.east},${bbox.south}`,
    bounded: "1"
  });

  const doFetch = () => fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: { "User-Agent": "TourismGuardian/1.0" }
  });

  let response: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await withNominatimThrottle(doFetch);
      if (response.ok) break;
      console.error(`[places] Nominatim nearby "${query}" attempt ${attempt} error ${response.status}`);
    } catch (e: any) {
      console.error(`[places] Nominatim nearby "${query}" attempt ${attempt} failed: ${e?.message || e}`);
      response = undefined;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  if (!response || !response.ok) return [];

  try {
    const data: any[] = await response.json();
    const places = data
      .map((place: any) => ({
        id: place.place_id?.toString(),
        displayName: { text: place.display_name?.split(",")[0] || query },
        formattedAddress: place.display_name || "",
        location: { latitude: Number(place.lat), longitude: Number(place.lon) },
        rating: undefined, currentOpeningHours: undefined, photos: [] as any[],
        nationalPhoneNumber: undefined, websiteUri: undefined, priceLevel: undefined,
        types: place.type ? [place.type] : []
      }))
      .filter((p: any) => Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude));
    if (places.length) nominatimNearbyCache.set(cacheKey, { at: Date.now(), places });
    return places;
  } catch {
    return [];
  }
}

export async function nearbySearch(
  text: string,
  lat: number,
  lng: number
) {
  const label: Record<string, string> = {
    police: "police station",
    train_station: "railway station",
    bus_station: "bus station",
    hospital: "hospital",
    hotel: "hotel",
    tourist: "tourist attraction"
  };
  const query = label[text] || text;

  const googleTypes = NEARBY_GOOGLE_TYPES[text];
  if (googleTypes) {
    const places = await googleTypeNearbySearch(googleTypes, lat, lng);
    if (places.length) return { places };
  }

  // Police stations, railway stations and bus stands don't reliably
  // geocode as free text with raw coordinates stuffed into the query
  // string (unlike "hospital"/"hotel", which happen to work as
  // Nominatim "special phrase" category terms even that way). Try
  // Overpass first (tag-based, most reliable for these categories),
  // then fall back to the bounded-viewbox Nominatim text search that
  // already works elsewhere in this app for fuel/EV station search.
  if (NEARBY_BOUNDED_NOMINATIM_TYPES.has(text)) {
    const overpassPlaces = await overpassNearbySearch(text, lat, lng);
    if (overpassPlaces.length) return { places: overpassPlaces };

    const places = await nominatimBoundedNearbySearch(query, lat, lng);
    if (places.length) return { places };
  }

  return placeSearch(`${query} near ${lat},${lng}`, lat, lng);
}

// ============================================================
// TOURIST ATTRACTIONS - OPENTRIPMAP
// ============================================================
//
// OpenTripMap is a dedicated sightseeing/POI dataset (kinds,
// Wikipedia extracts, images), and unlike the public Overpass
// mirrors used elsewhere, it's a single reliable HTTPS endpoint
// with an API key — no 429/504/aborted-mirror flakiness. Used as
// a point search here; places.ts samples this along a route for
// "along-route-attractions".
// ============================================================

export function openTripMapCategory(kinds: string) {
  const first = (kinds || "").split(",")[0] || "";
  if (first.includes("waterfall")) return "waterfall";
  if (first.includes("view_points")) return "viewpoint";
  if (first.includes("museum")) return "museum";
  if (first.includes("monuments") || first.includes("archaeology") || first.includes("fortifications") || first.includes("historic")) return "historical";
  if (first.includes("religion")) return "temple";
  if (first.includes("gardens_and_parks") || first.includes("natural")) return "park";
  return "tourist";
}

export async function touristAttractionsSearch(
  lat: number,
  lng: number,
  radiusMeters: number = 10000,
  kinds: string = "interesting_places"
) {
  const key = process.env.OPENTRIPMAP_API_KEY;

  if (!key) {
    console.error("[opentripmap] OPENTRIPMAP_API_KEY not set, falling back to placeSearch");
    return placeSearch("tourist attraction", lat, lng);
  }

  try {
    const params = new URLSearchParams({
      radius: String(radiusMeters),
      lon: String(lng),
      lat: String(lat),
      kinds,
      format: "json",
      limit: "20",
      apikey: key
    });

    const response = await fetch(`${OPENTRIPMAP_URL}/radius?${params.toString()}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[opentripmap] radius search error ${response.status}: ${body.slice(0, 300)}`);
      return placeSearch("tourist attraction", lat, lng);
    }

    const data: any[] = await response.json();
    const places = data
      .filter((place) => place?.name)
      .map((place) => ({
        id: `opentripmap-${place.xid}`,
        displayName: { text: place.name || "Unknown place" },
        formattedAddress: "",
        location: { latitude: Number(place.point?.lat), longitude: Number(place.point?.lon) },
        rating: place.rate,
        currentOpeningHours: undefined,
        photos: [],
        nationalPhoneNumber: undefined,
        websiteUri: undefined,
        priceLevel: undefined,
        category: openTripMapCategory(place.kinds || ""),
        types: place.kinds ? place.kinds.split(",") : []
      }));

    if (!places.length) return placeSearch("tourist attraction", lat, lng);
    return { places };
  } catch (e: any) {
    console.error(`[opentripmap] radius search request failed: ${e?.message || e}`);
    return placeSearch("tourist attraction", lat, lng);
  }
}

// Fetch rich detail (description, image, Wikipedia extract) for a
// single OpenTripMap place, given its xid (returned as the `-xid`
// suffix of `id` above, e.g. "opentripmap-<xid>").
export async function touristAttractionDetail(xid: string) {
  const key = process.env.OPENTRIPMAP_API_KEY;
  if (!key) throw new Error("OPENTRIPMAP_API_KEY not set");

  const response = await fetch(
    `${OPENTRIPMAP_URL}/xid/${encodeURIComponent(xid)}?apikey=${key}`
  );
  if (!response.ok) {
    throw new Error(`OpenTripMap detail error ${response.status}`);
  }
  return await response.json();
}

// ============================================================
// REAL ROAD ROUTING - OSRM
// ============================================================

export async function computeRoutes(
  origin: {
    lat: number;
    lng: number;
  },
  destination: {
    lat: number;
    lng: number;
  }
) {
  const coordinates =
    `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;

  const url =
    `${OSRM_URL}/${coordinates}` +
    `?alternatives=true` +
    `&steps=true` +
    `&overview=full` +
    `&geometries=geojson`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `OSRM routing error ${response.status}`
    );
  }

  const data: any = await response.json();

  if (
    data.code !== "Ok" ||
    !data.routes?.length
  ) {
    throw new Error("No road route found");
  }

  const routes = data.routes.map(
    (route: any, index: number) => ({
      routeIndex: index,
      distanceMeters: route.distance,
      duration: `${Math.round(route.duration / 60)} min`,
      staticDuration: `${Math.round(route.duration / 60)} min`,

      // Kept for frontend compatibility.
      // OSRM returns GeoJSON geometry below instead.
      polyline: {
        encodedPolyline: undefined
      },

      // OSRM road geometry: [longitude, latitude]
      geometry: {
        coordinates: route.geometry?.coordinates || []
      },

      safetyScore: 100,
      safetyLabel: "Calculating safety...",

      steps: route.legs
        ?.flatMap((leg: any) => leg.steps || [])
        .map((step: any) => {
          const type = String(step.maneuver?.type || "").toLowerCase();
          const modifier = String(step.maneuver?.modifier || "").toLowerCase();
          const road = String(step.name || "").trim();
          let instruction = "Continue";
          if (type === "depart") instruction = road ? `Towards ${road}` : "Start and continue";
          else if (type === "arrive") instruction = "Arrive at your destination";
          else if (type === "roundabout" || type === "rotary") instruction = road ? `Take the roundabout towards ${road}` : "Take the roundabout";
          else if (modifier.includes("left")) instruction = road ? `Turn left onto ${road}` : "Turn left";
          else if (modifier.includes("right")) instruction = road ? `Turn right onto ${road}` : "Turn right";
          else if (type === "new name" || type === "continue") instruction = road ? `Continue towards ${road}` : "Continue straight";
          else if (road) instruction = `Continue towards ${road}`;
          return {
            instruction,
            roadName: road || undefined,
            distanceMeters: step.distance,
            location: step.maneuver?.location
              ? { latitude: step.maneuver.location[1], longitude: step.maneuver.location[0] }
              : undefined
          };
        }) || []
    })
  );

  return { routes };
}

// ============================================================
// NEAREST ROAD
// ============================================================
//
// OSRM doesn't provide the same Roads API endpoint.
// For the prototype, return the supplied location.
// ============================================================

export async function nearestRoads(
  lat: number,
  lng: number
) {
  return {
    snappedPoints: [
      {
        location: {
          latitude: lat,
          longitude: lng
        }
      }
    ]
  };
}

// ============================================================
// DISTANCE CALCULATION
// ============================================================

export function haversineMeters(
  a: {
    lat: number;
    lng: number;
  },
  b: {
    lat: number;
    lng: number;
  }
) {
  const R = 6371000;

  const p1 =
    a.lat * Math.PI / 180;

  const p2 =
    b.lat * Math.PI / 180;

  const dp =
    (b.lat - a.lat) *
    Math.PI / 180;

  const dl =
    (b.lng - a.lng) *
    Math.PI / 180;

  const x =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(dl / 2) ** 2;

  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(x)
    )
  );
}

// ============================================================
// HOTEL SEARCH - Google Places when a server key is configured,
// with OpenStreetMap fallback so the app remains usable.
// ============================================================
export async function hotelSearch(lat: number, lng: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key && key !== "your_server_side_google_maps_key") {
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.nationalPhoneNumber,places.websiteUri,places.currentOpeningHours"
        },
        body: JSON.stringify({ textQuery: "hotels near me", locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 10000 } }, maxResultCount: 10 })
      });
      if (response.ok) return await response.json();
    } catch {}
  }
  return placeSearch(`hotels near ${lat},${lng}`, lat, lng);
}