import mongoose from "mongoose";
import dns from "dns";
import { env } from "./env.js";

// Use reliable DNS servers for MongoDB SRV resolution.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

export async function connectDatabase() {
  try {
    await mongoose.connect(env.MONGODB_URI);

    console.log("MongoDB connected");
  } catch (err: any) {
    console.error(
      "MongoDB connection failed. Check MONGODB_URI in your .env and confirm the cluster/network access allows this server's IP.\n" +
        `Reason: ${err.message}`
    );

    process.exit(1);
  }
}