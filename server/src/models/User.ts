import mongoose, { Schema } from "mongoose";

const UserSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["tourist", "authority"], default: "tourist" },
  trustedContact: {
    name: String,
    phone: String,
    email: String
  }
}, { timestamps: true });

export const User = mongoose.model("User", UserSchema);
