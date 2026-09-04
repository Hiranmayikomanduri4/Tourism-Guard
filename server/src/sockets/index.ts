import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/User.js";

// CLIENT_URL may be a single origin or a comma-separated list — see app.ts.
const allowedSocketOrigins = env.CLIENT_URL.split(",").map((o) => o.trim()).filter(Boolean);

export function createSocketServer(httpServer: any) {
  const io = new Server(httpServer, { cors: { origin: allowedSocketOrigins, methods: ["GET", "POST"] } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication required"));
      const payload = jwt.verify(token, env.JWT_SECRET) as { id: string };
      const user = await User.findById(payload.id).select("_id role");
      if (!user) return next(new Error("User not found"));
      (socket as any).user = user;
      next();
    } catch { next(new Error("Invalid authentication token")); }
  });
  io.on("connection", socket => {
    const user = (socket as any).user;
    socket.join(`user:${user._id}`);
    socket.on("join-authority", () => { if (user.role === "authority") socket.join("authority"); });
  });
  return io;
}
