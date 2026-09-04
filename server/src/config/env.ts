import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // Optional: every backend feature that can use Google Places already
  // falls back to OpenStreetMap/Overpass when this isn't configured, so
  // it must not be required just to boot the server.
  GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  OPENTRIPMAP_API_KEY: z.string().min(1).optional(),
  WEATHER_API_KEY: z.string().min(1),
  // Comma-separated list of allowed frontend origins (Vercel production
  // URL, any preview URLs, local dev), e.g.
  // "https://tourism-guardian.vercel.app,http://localhost:5173"
  CLIENT_URL: z.string().min(1),
  SOCKET_URL: z.string().url(),
  AUTHORITY_INVITE_CODE: z.string().min(8).optional(),
  TRUSTED_CONTACT_WEBHOOK_URL: z.string().url().optional()
});

export const env = schema.parse(process.env);
