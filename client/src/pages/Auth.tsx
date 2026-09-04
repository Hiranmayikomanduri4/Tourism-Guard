import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../store";
import { useNavigate } from "react-router-dom";

export default function Auth() {
  const [mode,setMode] = useState<"login"|"register">("register");
  const [form,setForm] = useState({name:"",email:"",password:"",role:"tourist",authorityCode:""});
  const [error,setError] = useState("");
  const setAuth = useAuth(s=>s.setAuth); const nav=useNavigate();
  const language = useAuth(s=>s.language);
  const setLanguage = useAuth(s=>s.setLanguage);
  const tx:any = {
    en:{register:"Register",login:"Login",name:"Name",email:"Email",password:"Password (8+ characters)",tourist:"Tourist",authority:"Authority (requires invite code)",create:"Create account",tag:"Explore Freely. Travel Safely."},
    te:{register:"రిజిస్టర్",login:"లాగిన్",name:"పేరు",email:"ఈమెయిల్",password:"పాస్‌వర్డ్ (8+ అక్షరాలు)",tourist:"పర్యాటకుడు",authority:"అధికారి (ఆహ్వాన కోడ్ అవసరం)",create:"ఖాతా సృష్టించండి",tag:"స్వేచ్ఛగా అన్వేషించండి. సురక్షితంగా ప్రయాణించండి."},
    hi:{register:"रजिस्टर",login:"लॉगिन",name:"नाम",email:"ईमेल",password:"पासवर्ड (8+ अक्षर)",tourist:"पर्यटक",authority:"अधिकारी (आमंत्रण कोड आवश्यक)",create:"खाता बनाएं",tag:"स्वतंत्र रूप से घूमें। सुरक्षित यात्रा करें।"},
    ta:{register:"பதிவு",login:"உள்நுழைவு",name:"பெயர்",email:"மின்னஞ்சல்",password:"கடவுச்சொல் (8+ எழுத்துகள்)",tourist:"சுற்றுலாப் பயணி",authority:"அதிகாரி (அழைப்புக் குறியீடு தேவை)",create:"கணக்கை உருவாக்கு",tag:"சுதந்திரமாக ஆராயுங்கள். பாதுகாப்பாக பயணம் செய்யுங்கள்."}
  };
  const T=(k:string)=>tx[language]?.[k]||tx.en[k];

  async function submit(e:any) {
    e.preventDefault(); setError("");
    try {
      const r = await api.post(`/auth/${mode}`, form);
      setAuth(r.data.token,r.data.user);
      nav(r.data.user.role==="authority"?"/authority":"/");
    } catch(e:any) { setError(e.response?.data?.message || "Request failed"); }
  }

  return <div className="auth"><div className="card auth-card">
    <h1>🛡️ Tourism Guardian</h1><p>{T("tag")}</p>
    <div style={{display:"flex",justifyContent:"flex-end",marginBottom:"8px"}}><select value={language} onChange={e=>setLanguage(e.target.value)} aria-label="Language"><option value="en">English</option><option value="te">తెలుగు</option><option value="hi">हिन्दी</option><option value="ta">தமிழ்</option></select></div>
    <div className="tabs"><button onClick={()=>setMode("register")} className={mode==="register"?"active":""}>{T("register")}</button><button onClick={()=>setMode("login")} className={mode==="login"?"active":""}>{T("login")}</button></div>
    <form onSubmit={submit}>
      {mode==="register" && <input placeholder={T("name")} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />}
      <input placeholder={T("email")} type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} />
      <input placeholder={T("password")} type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} />
      {mode === "register" && (
  <>
    <select
      value={form.role}
      onChange={e => setForm({ ...form, role: e.target.value })}
    >
      <option value="tourist">{T("tourist")}</option>
      <option value="authority">{T("authority")}</option>
    </select>

    {form.role === "authority" && (
      <input
        placeholder="Authority invite code"
        value={form.authorityCode}
        onChange={e =>
          setForm({ ...form, authorityCode: e.target.value })
        }
      />
    )}
  </>
)}
      {error && <div className="error">{error}</div>}
      <button className="primary">{mode==="register"?T("create"):T("login")}</button>
    </form>
    <small>Use real credentials. Authority registration requires a server-side invite code; authority sockets are RBAC protected.</small>
  </div></div>
}
