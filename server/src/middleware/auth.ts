import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/User.js";

export async function auth(req: any, res: any, next: any) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ message: "Authentication required" });
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string };
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!user) return res.status(401).json({ message: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Invalid authentication token" });
  }
}

export function requireAuthority(req: any, res: any, next: any) {
  if (req.user?.role !== "authority") return res.status(403).json({ message: "Authority access required" });
  next();
}
