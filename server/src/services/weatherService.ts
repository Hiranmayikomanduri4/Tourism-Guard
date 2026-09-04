import { env } from "../config/env.js";

export async function getWeather(lat: number, lng: number) {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(env.WEATHER_API_KEY)}&units=metric`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Weather API error ${r.status}`);
  const d: any = await r.json();
  return {
    temperature: d.main?.temp,
    feelsLike: d.main?.feels_like,
    condition: d.weather?.[0]?.description,
    windSpeed: d.wind?.speed,
    visibility: d.visibility,
    updatedAt: new Date().toISOString()
  };
}
