export default function LiveStatus({ battery, online }: { battery:number|null; online:boolean }) {
  return <div className="status-grid">
    <div><b>📡 Network</b><span>{online ? "Online" : "Offline"}</span></div>
    <div><b>🔋 Battery</b><span>{battery === null ? "Unavailable" : `${battery}%`}</span></div>
  </div>;
}
