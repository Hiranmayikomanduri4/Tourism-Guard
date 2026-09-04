import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../store";

export default function Profile() {
  const navigate = useNavigate();
  const user = useAuth(s => s.user);
  const language = useAuth(s => s.language);
  const [form, setForm] = useState({ name: user?.name || "", email: user?.email || "", contactName: "", contactPhone: "" });
  const [message, setMessage] = useState("");
  const setLanguage = useAuth(s=>s.setLanguage);
  const tx:any = {
    en:{home:"Home",profile:"Profile",name:"Name",email:"Email",contact:"Emergency Contact",save:"Save details",lang:"Language"},
    te:{home:"హోమ్",profile:"ప్రొఫైల్",name:"పేరు",email:"ఈమెయిల్",contact:"అత్యవసర సంప్రదింపు",save:"వివరాలు సేవ్ చేయండి",lang:"భాష"},
    hi:{home:"होम",profile:"प्रोफ़ाइल",name:"नाम",email:"ईमेल",contact:"आपातकालीन संपर्क",save:"विवरण सहेजें",lang:"भाषा"},
    ta:{home:"முகப்பு",profile:"சுயவிவரம்",name:"பெயர்",email:"மின்னஞ்சல்",contact:"அவசர தொடர்பு",save:"விவரங்களை சேமி",lang:"மொழி"}
  };
  const T=(k:string)=>tx[language]?.[k]||tx.en[k];

  useEffect(() => {
    api.get("/auth/me").then(r => {
      const u = r.data;
      setForm({ name: u.name || "", email: u.email || "", contactName: u.trustedContact?.name || "", contactPhone: u.trustedContact?.phone || "" });
      localStorage.setItem("tg_user", JSON.stringify(u));
    }).catch(() => {
      const u:any = JSON.parse(localStorage.getItem("tg_user") || "null");
      if (u?.trustedContact) setForm(f => ({...f, contactName:u.trustedContact.name || "", contactPhone:u.trustedContact.phone || ""}));
    });
  }, []);

  async function save(e:any) {
    e.preventDefault();
    try {
      const r = await api.patch("/auth/me", { name: form.name, trustedContact: { name: form.contactName, phone: form.contactPhone } });
      useAuth.setState({ user: r.data });
      localStorage.setItem("tg_user", JSON.stringify(r.data));
      setMessage("Profile and emergency contact saved.");
    } catch { setMessage("Could not save while offline. Please try again when online."); }
  }

  return <div className="app">
    <header><div><b>🛡️ Tourism Guardian</b><small>Profile & emergency contact</small></div><div style={{display:"flex",gap:8,alignItems:"center"}}><select value={language} onChange={e=>setLanguage(e.target.value)} aria-label={T("lang")}><option value="en">English</option><option value="te">తెలుగు</option><option value="hi">हिन्दी</option><option value="ta">தமிழ்</option></select><button onClick={() => navigate("/")}>← {T("home")}</button></div></header>
    <main>
      <section className="card profile-card">
        <h1>👤 {T("profile")}</h1>
        <form onSubmit={save} className="profile-form">
          <label>{T("name")}<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
          <label>{T("email")}<input value={form.email} disabled/></label>
          <h2>🚨 {T("contact")}</h2>
          <p className="muted">This contact is offered for quick calling after SOS.</p>
          <label>Contact name<input value={form.contactName} placeholder="e.g. Mother" onChange={e=>setForm({...form,contactName:e.target.value})}/></label>
          <label>Contact phone<input type="tel" value={form.contactPhone} placeholder="+91..." onChange={e=>setForm({...form,contactPhone:e.target.value})}/></label>
          {message && <p className="muted">{message}</p>}
          <button className="primary">{T("save")}</button>
        </form>
      </section>
    </main>
  </div>
}
