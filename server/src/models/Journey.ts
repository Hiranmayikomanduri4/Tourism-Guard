import mongoose, { Schema } from "mongoose";

const JourneySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  source: {
    placeId: String,
    name: String,
    lat: Number,
    lng: Number,
    address: String
  },
  destination: {
    placeId: String,
    name: String,
    lat: Number,
    lng: Number,
    address: String
  },
  status: { type: String, enum: ["active", "ended"], default: "active" },
  consentedTracking: { type: Boolean, default: false },
  lastLocation: {
    lat: Number,
    lng: Number,
    accuracy: Number,
    speed: Number,
    heading: Number,
    timestamp: Date
  }
}, { timestamps: true });

export const Journey = mongoose.model("Journey", JourneySchema);
