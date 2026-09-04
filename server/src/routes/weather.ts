import { Router } from "express";
import { getWeather } from "../services/weatherService.js";

const router = Router();
router.get("/", async (req, res) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "lat and lng required" });
    res.json(await getWeather(lat, lng));
  } catch (e: any) { res.status(502).json({ message: "Live weather unavailable", detail: e.message }); }
});
export default router;
