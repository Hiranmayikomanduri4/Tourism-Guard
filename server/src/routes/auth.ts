import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { auth } from "../middleware/auth.js";

const router = Router();
const schema = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8), role: z.enum(["tourist","authority"]).default("tourist"), authorityCode: z.string().optional() });

router.post("/register", async (req, res) => {
  try {
    const data = schema.parse(req.body);
    const exists = await User.findOne({ email: data.email });
    if (exists) return res.status(409).json({ message: "Email already registered" });
    if (data.role === "authority" && (!env.AUTHORITY_INVITE_CODE || data.authorityCode !== env.AUTHORITY_INVITE_CODE)) return res.status(403).json({ message: "Valid authority invite code required" });
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await User.create({ name:data.name, email:data.email, role:data.role, passwordHash });
    const token = jwt.sign({ id: user.id }, env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, trustedContact: user.trustedContact } });
  } catch (e: any) { res.status(400).json({ message: e.message }); }
});

router.post("/login", async (req, res) => {
  try {
    const data = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user: any = await User.findOne({ email: data.email });
    if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: user.id }, env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, trustedContact: user.trustedContact } });
  } catch (e: any) { res.status(400).json({ message: e.message }); }
});



router.get("/me", auth, async (req: any, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, trustedContact: req.user.trustedContact || {} });
});

router.patch("/me", auth, async (req: any, res) => {
  const { name, trustedContact } = req.body;
  const update: any = {};
  if (typeof name === "string" && name.trim().length >= 2) update.name = name.trim();
  if (trustedContact) update.trustedContact = {
    name: String(trustedContact.name || "").trim(),
    phone: String(trustedContact.phone || "").trim()
  };
  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true }).select("-passwordHash");
  if (!user) {
  return res.status(404).json({ message: "User not found" });
}
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, trustedContact: user.trustedContact || {} });
});

export default router;
