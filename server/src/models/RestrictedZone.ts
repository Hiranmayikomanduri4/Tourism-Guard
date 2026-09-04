import mongoose, { Schema } from "mongoose";

const RestrictedZoneSchema = new Schema({
  name: { type: String, required: true },
  reason: { type: String, required: true },
  source: { type: String, required: true },
  lastUpdated: { type: Date, required: true },
  geometry: {
    type: { type: String, enum: ["Polygon", "MultiPolygon"], required: true },
    coordinates: { type: Schema.Types.Mixed, required: true }
  },
  enabled: { type: Boolean, default: true }
});
RestrictedZoneSchema.index({ geometry: "2dsphere" });
export const RestrictedZone = mongoose.model("RestrictedZone", RestrictedZoneSchema);
