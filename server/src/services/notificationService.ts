import { env } from "../config/env.js";

export async function notifyTrustedContact(payload: Record<string, unknown>) {
  if (!env.TRUSTED_CONTACT_WEBHOOK_URL) return { sent: false, reason: "Trusted-contact notification provider is not configured" };
  try {
    const r = await fetch(env.TRUSTED_CONTACT_WEBHOOK_URL, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
    return { sent:r.ok, reason:r.ok ? undefined : `Provider returned ${r.status}` };
  } catch (e:any) { return { sent:false, reason:e.message }; }
}
