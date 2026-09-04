export function startImpactMonitor(onPossibleImpact: () => void) {
  let last = 0;
  const handler = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const magnitude = Math.sqrt((a.x || 0)**2 + (a.y || 0)**2 + (a.z || 0)**2);
    const now = Date.now();
    if (magnitude > 22 && now - last > 8000) { last = now; onPossibleImpact(); }
  };
  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}
