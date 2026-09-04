import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { api } from "../api";
import { useAuth } from "../store";
import { useNavigate } from "react-router-dom";
import MapView from "../components/MapView";

export default function Authority() {
  const [events,setEvents]=useState<any[]>([]);
  const [error,setError]=useState("");
  const user=useAuth(s=>s.user);
  const navigate=useNavigate();
  const language=useAuth(s=>s.language);
  const setLanguage=useAuth(s=>s.setLanguage);
  const tx:any={en:{home:"Home",logout:"Logout",history:"SOS / Emergency History"},te:{home:"హోమ్",logout:"లాగౌట్",history:"SOS / అత్యవసర చరిత్ర"},hi:{home:"होम",logout:"लॉगआउट",history:"SOS / आपातकालीन इतिहास"},ta:{home:"முகப்பு",logout:"வெளியேறு",history:"SOS / அவசர வரலாறு"}};
  const T=(k:string)=>tx[language]?.[k]||tx.en[k];

  async function loadHistory() {
    try {
      setError("");
      const r=await api.get("/emergency/history");
      setEvents(r.data || []);
    } catch (e:any) {
      setError(e.response?.data?.message || "Authority access is required to view emergency records.");
    }
  }

  useEffect(()=>{
    if (user?.role !== "authority") return;
    loadHistory();
    const socketUrl=import.meta.env.VITE_SOCKET_URL || window.location.origin;
    const socket=io(socketUrl,{auth:{token:useAuth.getState().token}});
    socket.on("connect",()=>socket.emit("join-authority"));
    socket.on("emergency:new",(e)=>setEvents(x=>[e,...x.filter(v=>v._id!==e._id)]));
    socket.on("emergency:updated",(e)=>setEvents(x=>x.map(v=>v._id===e._id?e:v)));
    socket.on("connect_error",()=>setError("Live authority connection unavailable. Refresh when the server is online."));
    return ()=>{socket.disconnect();};
  },[user?.role]);

  async function status(id:string,status:string){
    try {
      const r=await api.patch(`/emergency/${id}/status`,{status});
      setEvents(x=>x.map(v=>v._id===id?r.data:v));
    } catch { setError("Could not update the emergency status."); }
  }

  return <div className="app">
    <header>
      <div><b>🛡️ Authority Dashboard</b><small>All SOS and emergency records</small></div>
      <div className="header-actions">
        <button onClick={()=>navigate("/")}>{T("home")}</button>
        <b>{user?.name}</b>
        <select value={language} onChange={e=>setLanguage(e.target.value)}><option value="en">English</option><option value="te">తెలుగు</option><option value="hi">हिन्दी</option><option value="ta">தமிழ்</option></select><button onClick={()=>useAuth.getState().logout()}>{T("logout")}</button>
      </div>
    </header>
    <main>
      {user?.role !== "authority" ? <section className="card">
        <h1>🛡️ Authority Dashboard</h1>
        <p>This screen is available, but emergency records can only be viewed by an Authority account.</p>
        <p className="muted">Log out and sign in/register as Authority using the existing authority invite code.</p>
      </section> : <section className="card">
        <h1>🚨 {T("history")}</h1>
        <p className="muted">Every SOS or automatic emergency event is recorded here with its exact time, tourist, location, trigger, risk score and hazards.</p>
        {error && <div className="error">{error}</div>}
        {events.length > 0 && (
          <div style={{ marginBottom: "18px" }}>
            <h2>📍 Tourist emergency locations</h2>
            <MapView
              language={language}
              destination={events[0]?.location?.coordinates ? {
                lat: Number(events[0].location.coordinates[1]),
                lng: Number(events[0].location.coordinates[0])
              } : undefined}
              places={events.filter(e => e.location?.coordinates).map(e => ({
                id: e._id,
                lat: Number(e.location.coordinates[1]),
                lng: Number(e.location.coordinates[0]),
                name: `🚨 ${e.type}`,
                category: "emergency",
                address: e.metadata?.translatedMessage || e.trigger || ""
              }))}
            />
          </div>
        )}
        {events.length===0?<div className="empty">No emergency records yet.</div>:<div className="events">{events.map(e=><article key={e._id} className="event">
          <div>
            <b>🚨 {e.type}</b>
            <span>🕒 {new Date(e.createdAt).toLocaleString()}</span>
            <span>Status: {e.status}</span>
            <span>Trigger: {e.trigger||"Not specified"}</span>
            <span>📍 Location: {e.location?.coordinates?.[1]}, {e.location?.coordinates?.[0]}</span>
            <span>👤 Tourist: {e.userId?.name || "Unknown"} · {e.userId?.email || "No email"}</span>
            {e.userId?.trustedContact?.phone && <span>📞 Emergency contact: {e.userId.trustedContact.name || "Contact"} · {e.userId.trustedContact.phone}</span>}
            {e.metadata?.translatedMessage && <span>🌐 {e.metadata.translatedMessage}</span>}
            {e.metadata?.riskScore !== undefined && <span>🛡️ Risk score: {e.metadata.riskScore}/100 · {e.metadata.riskLevel || ""}</span>}
            {Array.isArray(e.metadata?.hazards) && e.metadata.hazards.length>0 && <span>⚠️ Hazards: {e.metadata.hazards.join("; ")}</span>}
          </div>
          <div>
            <button onClick={()=>status(e._id,"ACKNOWLEDGED")}>Acknowledge</button>
            <button onClick={()=>status(e._id,"RESPONDING")}>Responding</button>
            <button onClick={()=>status(e._id,"RESOLVED")}>Resolve</button>
          </div>
        </article>)}</div>}
      </section>}
    </main>
  </div>
}
