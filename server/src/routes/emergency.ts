import { Router } from "express";
import { auth, requireAuthority } from "../middleware/auth.js";
import { EmergencyEvent } from "../models/EmergencyEvent.js";

const router = Router();

router.post("/", auth, async (req: any, res) => {
  const { type, journeyId, lat, lng, trigger, metadata } = req.body;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: "A real current location is required" });
  const event = await EmergencyEvent.create({ userId: req.user._id, journeyId, type, trigger, metadata, location: { type: "Point", coordinates: [lng, lat] } });
  await event.populate("userId", "name email trustedContact");
  req.app.get("io").to("authority").emit("emergency:new", event);
  res.status(201).json(event);
});

router.get("/active", auth, requireAuthority, async (_req, res) => {
  res.json(await EmergencyEvent.find({ status: { $ne: "RESOLVED" } }).populate("userId", "name email trustedContact").sort({ createdAt: -1 }).limit(100));
});

// Full authority history, including resolved SOS/emergency events.
router.get("/history", auth, requireAuthority, async (_req, res) => {
  res.json(await EmergencyEvent.find({}).populate("userId", "name email trustedContact").sort({ createdAt: -1 }).limit(200));
});

router.patch("/:id/status", auth, requireAuthority, async (req: any, res) => {
  const allowed = ["CREATED", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"];
  const { status } = req.body;
  if (!allowed.includes(status)) return res.status(400).json({ message: "Invalid status" });
  const event = await EmergencyEvent.findByIdAndUpdate(req.params.id, { status, responseStatus: status }, { new: true });
  if (!event) return res.status(404).json({ message: "Event not found" });
  await event.populate("userId", "name email trustedContact");
  req.app.get("io").to("authority").emit("emergency:updated", event);
  req.app.get("io").to(`user:${event.userId}`).emit("emergency:updated", event);
  res.json(event);
});

export default router;
