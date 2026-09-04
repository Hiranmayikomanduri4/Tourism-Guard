import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import authRoutes from "./routes/auth.js";
import placeRoutes from "./routes/places.js";
import routeRoutes from "./routes/routes.js";
import weatherRoutes from "./routes/weather.js";
import journeyRoutes from "./routes/journeys.js";
import emergencyRoutes from "./routes/emergency.js";
import plannerRoutes from "./routes/planner.js";

// CLIENT_URL may be a single origin or a comma-separated list (e.g. the
// production Vercel URL plus preview deployments / local dev), so the
// deployed frontend always passes CORS regardless of which legitimate
// origin it's served from.
const allowedOrigins = env.CLIENT_URL.split(",").map((o) => o.trim()).filter(Boolean);

function isAllowedOrigin(origin: string) {
  return allowedOrigins.some((allowed) => {
    if (allowed === origin) return true;
    // Allow a Vercel preview-deployment pattern like
    // "https://*.vercel.app" to be listed once instead of every preview URL.
    if (allowed.includes("*")) {
      const pattern = "^" + allowed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
      return new RegExp(pattern).test(origin);
    }
    return false;
  });
}

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      // No Origin header (server-to-server calls, curl, health checks) — allow.
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      console.error(`[cors] Blocked request from origin: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "tourism-guardian" }));
  app.use("/api/auth", authRoutes);
  app.use("/api/places", placeRoutes);
  app.use("/api/routes", routeRoutes);
  app.use("/api/weather", weatherRoutes);
  app.use("/api/journeys", journeyRoutes);
  app.use("/api/emergency", emergencyRoutes);
  app.use("/api/planner", plannerRoutes);

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
