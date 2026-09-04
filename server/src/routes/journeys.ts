import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { Journey } from "../models/Journey.js";
import { RestrictedZone } from "../models/RestrictedZone.js";
import { EmergencyEvent } from "../models/EmergencyEvent.js";
import { notifyTrustedContact } from "../services/notificationService.js";

const router = Router();

router.post("/", auth, async (req: any, res) => {
  const { destination, consentedTracking } = req.body;
  if (!consentedTracking) return res.status(400).json({ message: "Location tracking consent is required" });
  const j = await Journey.create({ userId: req.user._id, destination, consentedTracking: true });
  res.status(201).json(j);
});

router.patch("/:id/location", auth, async (req: any, res) => {
  const { lat, lng, accuracy, speed, heading, timestamp, battery, online } = req.body;
  if (![lat,lng].every(Number.isFinite)) return res.status(400).json({ message: "Real location required" });
  const j = await Journey.findOneAndUpdate({ _id: req.params.id, userId: req.user._id, status: "active" },
    { lastLocation: { lat, lng, accuracy, speed, heading, timestamp: new Date(timestamp || Date.now()) } }, { new: true });
  if (!j) return res.status(404).json({ message: "Active journey not found" });

  const point = { type: "Point", coordinates: [lng, lat] };
  const hits = await RestrictedZone.find({ enabled: true, geometry: { $geoIntersects: { $geometry: point } } }).lean();
  if (hits.length) {
    const existing = await EmergencyEvent.findOne({ journeyId: j._id, type: "RESTRICTED_ZONE", status: { $ne: "RESOLVED" } });
    if (!existing) {
      const event = await EmergencyEvent.create({ userId: req.user._id, journeyId: j._id, type: "RESTRICTED_ZONE", trigger: "GEOFENCE_ENTRY", location: point, metadata: { zones: hits.map(z => ({ id: z._id, name: z.name, reason: z.reason, source: z.source, lastUpdated: z.lastUpdated })), battery, online } });
      req.app.get("io").to("authority").emit("emergency:new", event);
    }
  }
  res.json({ ok: true, restrictedZones: hits.map(z => ({ id: z._id, name: z.name, reason: z.reason, source: z.source, lastUpdated: z.lastUpdated })) });
});

router.post("/:id/handshake", auth, async (req: any, res) => {
  const { lat, lng, trigger, battery, online, language, translatedMessage } = req.body;
  if (![lat,lng].every(Number.isFinite)) return res.status(400).json({ message: "Real location required" });
  const event = await EmergencyEvent.create({ userId: req.user._id, journeyId: req.params.id, type: "UNRESPONSIVE_HANDSHAKE", trigger: trigger || "GUARDIAN_HANDSHAKE", escalationLevel: 2, responseStatus: "PENDING", location: { type: "Point", coordinates: [lng,lat] }, metadata: { battery, online, language, translatedMessage } });
  req.app.get("io").to("authority").emit("emergency:new", event);
  const contact = (await import("../models/User.js")).User.findById(req.user._id).select("name email trustedContact");
  const u:any = await contact;
  const notification = await notifyTrustedContact({ eventId:event._id, type:event.type, trigger:event.trigger, tourist:{name:u?.name,email:u?.email}, trustedContact:u?.trustedContact, location:{lat,lng}, timestamp:event.createdAt });
  await EmergencyEvent.findByIdAndUpdate(event._id,{ metadata:{ battery, online, trustedContactNotification:notification } });
  res.status(201).json({ event, notification });
});

router.patch("/:id/end", auth, async (req: any, res) => {
  const j = await Journey.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { status: "ended" }, { new: true });
  if (!j) return res.status(404).json({ message: "Journey not found" });
  res.json(j);
});

export default router;
