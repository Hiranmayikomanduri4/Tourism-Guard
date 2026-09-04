export async function readBattery() {
  const nav = navigator as any;
  if (!nav.getBattery) return null;
  const b = await nav.getBattery();
  return { level: Math.round(b.level * 100), charging: b.charging };
}
