import mongoose, { Schema } from "mongoose";

const EmergencyEventSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  journeyId: { type: Schema.Types.ObjectId, ref: "Journey" },
  type: {
    type: String,
    enum: ["MANUAL_SOS", "POSSIBLE_IMPACT", "UNRESPONSIVE_HANDSHAKE", "RESTRICTED_ZONE", "HIGH_RISK", "ROUTE_DEVIATION"],
    required: true
  },
  status: { type: String, enum: ["CREATED", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"], default: "CREATED" },
  escalationLevel: { type: Number, default: 1 },
  responseStatus: { type: String, default: "PENDING" },
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }
  },
  trigger: String,
  metadata: Schema.Types.Mixed
}, { timestamps: true });

EmergencyEventSchema.index({ location: "2dsphere" });
export const EmergencyEvent = mongoose.model("EmergencyEvent", EmergencyEventSchema);
