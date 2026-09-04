export type LocationState = { lat:number; lng:number; accuracy:number; speed?:number|null; heading?:number|null; timestamp:number };

export function getCurrentLocation(): Promise<LocationState> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation unsupported"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      p => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
        speed: p.coords.speed,
        heading: p.coords.heading,
        timestamp: p.timestamp
      }),
      reject,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  });
}

export function watchLocation(onLocation: (l: LocationState) => void, onError: (e: GeolocationPositionError) => void) {
  if (!navigator.geolocation) { onError({ code: 0, message: "Geolocation unsupported" } as GeolocationPositionError); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    p => onLocation({ lat:p.coords.latitude, lng:p.coords.longitude, accuracy:p.coords.accuracy, speed:p.coords.speed, heading:p.coords.heading, timestamp:p.timestamp }),
    onError,
    { enableHighAccuracy:true, maximumAge:3000, timeout:15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}
