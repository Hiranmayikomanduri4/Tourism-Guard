import { Router } from "express";
import { computeRoutes, nearestRoads } from "../services/googleService.js";
import { RestrictedZone } from "../models/RestrictedZone.js";
import { getWeather } from "../services/weatherService.js";
import { pointInGeometry } from "../services/polyline.js";

const router = Router();

router.post("/compute", async (req, res) => {
  try {
    const { origin, destination } = req.body;
    if (!origin || !destination) return res.status(400).json({ message: "origin and destination required" });
    const data = await computeRoutes(origin, destination);
    const zones = await RestrictedZone.find({ enabled: true }).lean();
    let weatherRisk = 0;
    let weatherAvailable = true;
    try { const w:any = await getWeather(origin.lat, origin.lng); const c=String(w.condition||"").toLowerCase(); if(/thunder|storm|tornado/.test(c)) weatherRisk=20; else if(/heavy rain|rain/.test(c)) weatherRisk=10; else if(/snow|sleet/.test(c)) weatherRisk=12; } catch { weatherAvailable=false; }
    const routes = (data.routes || []).map((r: any, originalIndex: number) => {
      // OSRM returns duration and staticDuration as already formatted minutes.
      // There is no live traffic value in the public OSRM response, so do not
      // pretend this is a real traffic delay.
      const trafficSeconds = 0;
      const trafficRisk = 0;

      // OSRM geometry is [[lng, lat], ...]. Convert it to the point format
      // expected by the restricted-zone checker.
      const coordinates = r.geometry?.coordinates || [];
      const points = coordinates
        .filter((p: any) => Array.isArray(p) && p.length >= 2)
        .map(([lng, lat]: [number, number]) => ({ lat, lng }));

      const restrictedHits = zones.filter((z: any) =>
        points.some((p: any) => pointInGeometry(p, z.geometry))
      );

      const restrictedRisk = restrictedHits.length ? 30 : 0;

      // Small distance penalty for unusually long routes.
      const distanceKm = Number(r.distanceMeters || 0) / 1000;
      const distanceRisk = distanceKm > 100 ? 5 : 0;

      const safetyScore = Math.max(
        0,
        Math.min(100, 100 - trafficRisk - weatherRisk - restrictedRisk - distanceRisk)
      );

      let safetyLabel = "LOW RISK";
      if (safetyScore < 40) safetyLabel = "HIGH RISK";
      else if (safetyScore < 70) safetyLabel = "MODERATE RISK";

      const predictiveRiskProbability = Math.max(0, Math.min(100, 100 - safetyScore));
      const predictiveLevel = predictiveRiskProbability >= 60 ? "HIGH" : predictiveRiskProbability >= 30 ? "MEDIUM" : "LOW";
      const predictiveFactors = [
        weatherRisk > 0 ? "Current weather may worsen travel conditions in the next 30 minutes" : "No severe weather signal in the current weather feed",
        restrictedRisk > 0 ? "Restricted/sensitive zone intersects this route" : "No configured restricted zone intersects this route"
      ];

      return {
        ...r,
        routeIndex: originalIndex,
        trafficDelaySeconds: trafficSeconds,
        safetyScore,
        safetyLabel,
        predictiveRiskProbability30Min: predictiveRiskProbability,
        predictiveRiskLevel30Min: predictiveLevel,
        predictiveSafetyNote30Min: predictiveFactors.join(". "),
        safetyFactors: {
          trafficRisk,
          trafficAvailable: false,
          weatherRisk,
          weatherAvailable,
          restrictedZoneRisk: restrictedRisk,
          distanceRisk,
          restrictedZones: restrictedHits.map((z: any) => ({
            id: z._id,
            name: z.name,
            reason: z.reason,
            source: z.source,
            lastUpdated: z.lastUpdated
          }))
        }
      };
    });

    // Safest route first.
    routes.sort((a: any, b: any) => b.safetyScore - a.safetyScore);
    res.json({ routes });
  } catch (e: any) { res.status(502).json({ message: "Live route data unavailable", detail: e.message }); }
});

router.get("/roads", async (req, res) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "Valid coordinates required" });
    res.json(await nearestRoads(lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Road data unavailable", detail: e.message }); }
});

export default router;
