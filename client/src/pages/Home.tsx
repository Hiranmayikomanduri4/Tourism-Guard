import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../store";
import MapView from "../components/MapView";
import LiveStatus from "../components/LiveStatus";
import { getCurrentLocation, watchLocation } from "../services/location";
import { readBattery } from "../services/battery";
import { startImpactMonitor } from "../services/sensors";
import { statePlaces } from "../statePlaces";

const states = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry"
];

type Place = any;

// --------------------------------------------------
// HAVERSINE DISTANCE (km) — used to sort stations by
// real distance from the user's live GPS location
// --------------------------------------------------
function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// --------------------------------------------------
// DECODE GOOGLE'S ENCODED POLYLINE
// /routes/compute returns each route's path as an
// encoded polyline (r.polyline.encodedPolyline) — this
// turns it back into real lat/lng points so we can check
// whether the user has drifted off it.
// --------------------------------------------------
function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

// Shortest distance (km) from a point to a single segment A-B,
// using a flat local projection (fine at city/road scale).
function distanceToSegmentKm(
  p: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const R = 6371;
  const toXY = (pt: { lat: number; lng: number }) => {
    const latRad = (pt.lat * Math.PI) / 180;
    return {
      x: R * ((pt.lng * Math.PI) / 180) * Math.cos(latRad),
      y: R * ((pt.lat * Math.PI) / 180)
    };
  };

  const P = toXY(p);
  const A = toXY(a);
  const B = toXY(b);

  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lengthSq = dx * dx + dy * dy;

  let t = lengthSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const projX = A.x + t * dx;
  const projY = A.y + t * dy;

  return Math.sqrt((P.x - projX) ** 2 + (P.y - projY) ** 2);
}

// Shortest distance (km) from the user's current point to
// the whole route path.
function minDistanceToPathKm(
  point: { lat: number; lng: number },
  path: { lat: number; lng: number }[]
) {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return distanceKm(point, path[0]);

  let min = Infinity;

  for (let i = 0; i < path.length - 1; i++) {
    const d = distanceToSegmentKm(point, path[i], path[i + 1]);
    if (d < min) min = d;
  }

  return min;
}

type AlertItem = {
  id: string;
  severity: "warning" | "critical";
  message: string;
  actionLabel?: string;
};

export default function Home({ view = "home" }: { view?: "home" | "destination" | "places" | "fuel" | "planner" | "journey" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const language = useAuth((s) => s.language);
  const setLanguage = useAuth((s) => s.setLanguage);
  const savedDestination = JSON.parse(localStorage.getItem("tg_selected_destination") || "null");
  const savedSource = JSON.parse(localStorage.getItem("tg_selected_source") || "null");
  const initialDestination = (location.state as any)?.destination || savedDestination;
  const initialSource = (location.state as any)?.source || savedSource;
  const labels: any = {
    en: {
      home:"Home", profile:"Profile", search:"Search", destination:"Destination", logout:"Logout",
      download:"Download for offline", plan:"Trip Planner", source:"Source", currentLocation:"Use My Current Location",
      searchSource:"Search source location", searchDestination:"Search destination location", findRoutes:"Find Safe Routes",
      startJourney:"START JOURNEY", attractions:"Famous & Local Places", current:"Current Location", nearbyDestination:"Destination",
      hospitals:"Hospitals", police:"Police Stations", hotels:"Hotels", transport:"Transport", fuel:"Filling Stations",
      safe:"Safe", moderate:"Moderate", high:"High Risk", risk:"Safety Risk", next30:"Next 30 min prediction",
      voice:"Voice", listen:"Listen", stateDiscovery:"Explore by State", selectState:"Select a state", statePlaces:"Places by district", back:"Back",
      nearbyPlaces:"Nearby places", fillingStations:"Filling stations", noNearby:"No nearby places found", noFuel:"No filling stations found", directions:"Turn-by-turn directions", nextTurn:"Next instruction",
      route:"Route", routeOptions:"Available routes", journeyMode:"Journey Mode", exitJourney:"Back to trip", currentRisk:"Predictive safety", hiddenSafety:"Hidden/local attraction safety",
      closingSoon:"Closing soon", verifyHours:"Verify actual opening hours before travel.", packageEstimate:"Estimated package cost", assumedPrices:"Assumed planning prices",
      stay:"Stay", food:"Food", localTransport:"Local transport", entryFees:"Entry fees / misc", generatePackage:"Generate day-wise package", days:"Number of days", totalBudget:"Total budget",
      destinationRequired:"Select a destination first.", sourceRequired:"Select a source first.", noStatePlaces:"No curated places are available for this district yet.", whereGo:"Where do you want to go?", realPlaces:"Real places", liveRecommendations:"Live recommendations",
      riskTitle:"Travel Risk Score", riskBasis:"Based on current weather, battery, connectivity and route conditions.", hazards:"Current hazards", noHazards:"No major hazards detected right now.", planRoute:"Plan a Safe Route", planRouteHelp:"Choose any source and destination, or use your live GPS location as the source. Location permission is required for current-location features and SOS.", notSelected:"Not selected", liveStatus:"Live status", nearbyArea:"Nearby search area", noResults:"No results found nearby.", directionsUnavailable:"Directions are not available for this route."
    },
    te: {
      home:"హోమ్", profile:"ప్రొఫైల్", search:"శోధన", destination:"గమ్యం", logout:"లాగౌట్",
      download:"ఆఫ్‌లైన్ కోసం డౌన్‌లోడ్", plan:"ట్రిప్ ప్లానర్", source:"ప్రారంభ స్థానం", currentLocation:"నా ప్రస్తుత స్థానం",
      searchSource:"ప్రారంభ స్థానాన్ని వెతకండి", searchDestination:"గమ్యాన్ని వెతకండి", findRoutes:"సురక్షిత మార్గాలను కనుగొనండి",
      startJourney:"జర్నీ ప్రారంభించండి", attractions:"ప్రముఖ & స్థానిక ప్రదేశాలు", current:"ప్రస్తుత స్థానం", nearbyDestination:"గమ్యం",
      hospitals:"ఆసుపత్రులు", police:"పోలీస్ స్టేషన్లు", hotels:"హోటళ్లు", transport:"రవాణా", fuel:"ఇంధన కేంద్రాలు",
      safe:"సురక్షితం", moderate:"మధ్యస్థ ప్రమాదం", high:"అధిక ప్రమాదం", risk:"భద్రతా ప్రమాదం", next30:"తదుపరి 30 నిమిషాల అంచనా",
      voice:"వాయిస్", listen:"వినండి", stateDiscovery:"రాష్ట్రం ద్వారా అన్వేషణ", selectState:"రాష్ట్రాన్ని ఎంచుకోండి", statePlaces:"జిల్లా వారీ ప్రదేశాలు", back:"వెనుకకు", nearbyPlaces:"సమీప ప్రదేశాలు", fillingStations:"ఇంధన కేంద్రాలు", noNearby:"సమీప ప్రదేశాలు లేవు", noFuel:"ఇంధన కేంద్రాలు లేవు", directions:"మలుపు-మలుపు దిశలు", nextTurn:"తదుపరి సూచన", route:"మార్గం", routeOptions:"అందుబాటులో ఉన్న మార్గాలు", journeyMode:"జర్నీ మోడ్", exitJourney:"ట్రిప్‌కు తిరిగి", currentRisk:"ముందస్తు భద్రత", hiddenSafety:"దాచిన/స్థానిక ప్రదేశాల భద్రత", closingSoon:"త్వరలో మూసివేయబడుతుంది", verifyHours:"ప్రయాణానికి ముందు నిజమైన ప్రారంభ/మూసే సమయాలను నిర్ధారించండి.", packageEstimate:"అంచనా ప్యాకేజీ ఖర్చు", assumedPrices:"అంచనా ప్రణాళిక ధరలు", stay:"వసతి", food:"ఆహారం", localTransport:"స్థానిక రవాణా", entryFees:"ప్రవేశ రుసుము / ఇతరాలు", generatePackage:"రోజువారీ ప్యాకేజీ రూపొందించండి", days:"రోజులు", totalBudget:"మొత్తం బడ్జెట్", destinationRequired:"ముందుగా గమ్యాన్ని ఎంచుకోండి.", sourceRequired:"ముందుగా ప్రారంభ స్థానాన్ని ఎంచుకోండి.", noStatePlaces:"ఈ జిల్లాకు ఇంకా ప్రదేశాల జాబితా లేదు.", whereGo:"మీరు ఎక్కడికి వెళ్లాలనుకుంటున్నారు?", realPlaces:"ప్రదేశాలు", liveRecommendations:"లైవ్ సిఫార్సులు", riskTitle:"ప్రయాణ భద్రతా స్కోర్", riskBasis:"ప్రస్తుత వాతావరణం, బ్యాటరీ, కనెక్టివిటీ మరియు మార్గ పరిస్థితుల ఆధారంగా.", hazards:"ప్రస్తుత ప్రమాదాలు", noHazards:"ప్రస్తుతం పెద్ద ప్రమాదాలు గుర్తించబడలేదు.", planRoute:"సురక్షిత మార్గాన్ని ప్లాన్ చేయండి", planRouteHelp:"ఏదైనా ప్రారంభ స్థానం మరియు గమ్యాన్ని ఎంచుకోండి లేదా మీ GPS స్థానాన్ని ప్రారంభ స్థానంగా ఉపయోగించండి. ప్రస్తుత స్థానం మరియు SOS కోసం స్థాన అనుమతి అవసరం.", notSelected:"ఎంచుకోలేదు", liveStatus:"ప్రస్తుత స్థితి", nearbyArea:"సమీప శోధన ప్రాంతం", noResults:"సమీపంలో ఫలితాలు లేవు.", directionsUnavailable:"ఈ మార్గానికి దిశలు అందుబాటులో లేవు."
    },
    hi: {
      home:"होम", profile:"प्रोफ़ाइल", search:"खोजें", destination:"गंतव्य", logout:"लॉगआउट",
      download:"ऑफलाइन डाउनलोड", plan:"ट्रिप प्लानर", source:"प्रस्थान स्थान", currentLocation:"मेरा वर्तमान स्थान",
      searchSource:"प्रस्थान स्थान खोजें", searchDestination:"गंतव्य खोजें", findRoutes:"सुरक्षित मार्ग खोजें",
      startJourney:"यात्रा शुरू करें", attractions:"प्रसिद्ध और स्थानीय स्थान", current:"वर्तमान स्थान", nearbyDestination:"गंतव्य",
      hospitals:"अस्पताल", police:"पुलिस स्टेशन", hotels:"होटल", transport:"परिवहन", fuel:"ईंधन स्टेशन",
      safe:"सुरक्षित", moderate:"मध्यम जोखिम", high:"उच्च जोखिम", risk:"सुरक्षा जोखिम", next30:"अगले 30 मिनट का अनुमान", voice:"आवाज़", listen:"सुनें", stateDiscovery:"राज्य के अनुसार खोजें", selectState:"राज्य चुनें", statePlaces:"जिले के अनुसार स्थान", back:"वापस", nearbyPlaces:"पास के स्थान", fillingStations:"ईंधन स्टेशन", noNearby:"पास में कोई स्थान नहीं मिला", noFuel:"कोई ईंधन स्टेशन नहीं मिला", directions:"मोड़-दर-मोड़ दिशा", nextTurn:"अगला निर्देश", route:"मार्ग", routeOptions:"उपलब्ध मार्ग", journeyMode:"यात्रा मोड", exitJourney:"ट्रिप पर वापस", currentRisk:"पूर्वानुमानित सुरक्षा", hiddenSafety:"छिपे/स्थानीय स्थानों की सुरक्षा", closingSoon:"जल्द बंद होगा", verifyHours:"यात्रा से पहले वास्तविक समय की पुष्टि करें।", packageEstimate:"अनुमानित पैकेज लागत", assumedPrices:"अनुमानित योजना कीमतें", stay:"ठहरना", food:"भोजन", localTransport:"स्थानीय परिवहन", entryFees:"प्रवेश शुल्क / अन्य", generatePackage:"दैनिक पैकेज बनाएं", days:"दिन", totalBudget:"कुल बजट", destinationRequired:"पहले गंतव्य चुनें।", sourceRequired:"पहले प्रारंभ स्थान चुनें।", noStatePlaces:"इस जिले के लिए अभी स्थान उपलब्ध नहीं हैं।", whereGo:"आप कहाँ जाना चाहते हैं?", realPlaces:"वास्तविक स्थान", liveRecommendations:"लाइव सुझाव", riskTitle:"यात्रा सुरक्षा स्कोर", riskBasis:"वर्तमान मौसम, बैटरी, कनेक्टिविटी और मार्ग की स्थिति पर आधारित।", hazards:"वर्तमान जोखिम", noHazards:"अभी कोई बड़ा जोखिम नहीं मिला।", planRoute:"सुरक्षित मार्ग की योजना", planRouteHelp:"कोई प्रारंभ स्थान और गंतव्य चुनें या GPS स्थान को प्रारंभ स्थान के रूप में उपयोग करें। वर्तमान स्थान और SOS के लिए अनुमति आवश्यक है।", notSelected:"चयनित नहीं", liveStatus:"लाइव स्थिति", nearbyArea:"पास का खोज क्षेत्र", noResults:"पास में कोई परिणाम नहीं मिला।", directionsUnavailable:"इस मार्ग के लिए दिशा उपलब्ध नहीं है।"
    },
    ta: {
      home:"முகப்பு", profile:"சுயவிவரம்", search:"தேடல்", destination:"இலக்கு", logout:"வெளியேறு",
      download:"ஆஃப்லைனில் பதிவிறக்கு", plan:"பயண திட்டம்", source:"தொடக்க இடம்", currentLocation:"என் தற்போதைய இடம்",
      searchSource:"தொடக்க இடத்தை தேடுங்கள்", searchDestination:"இலக்கை தேடுங்கள்", findRoutes:"பாதுகாப்பான வழிகளை கண்டறி",
      startJourney:"பயணத்தை தொடங்கு", attractions:"பிரபல & உள்ளூர் இடங்கள்", current:"தற்போதைய இடம்", nearbyDestination:"இலக்கு",
      hospitals:"மருத்துவமனைகள்", police:"காவல் நிலையங்கள்", hotels:"ஹோட்டல்கள்", transport:"போக்குவரத்து", fuel:"எரிபொருள் நிலையங்கள்",
      safe:"பாதுகாப்பானது", moderate:"மிதமான ஆபத்து", high:"அதிக ஆபத்து", risk:"பாதுகாப்பு ஆபத்து", next30:"அடுத்த 30 நிமிட கணிப்பு", voice:"குரல்", listen:"கேளுங்கள்", stateDiscovery:"மாநில வாரியாக தேடல்", selectState:"மாநிலத்தை தேர்வு செய்யவும்", statePlaces:"மாவட்ட வாரியான இடங்கள்", back:"பின்செல்", nearbyPlaces:"அருகிலுள்ள இடங்கள்", fillingStations:"எரிபொருள் நிலையங்கள்", noNearby:"அருகில் இடங்கள் இல்லை", noFuel:"எரிபொருள் நிலையங்கள் இல்லை", directions:"திருப்பம்-திருப்பமாக வழிகாட்டுதல்", nextTurn:"அடுத்த அறிவுரை", route:"வழி", routeOptions:"கிடைக்கும் வழிகள்", journeyMode:"பயண முறை", exitJourney:"பயணத்திற்கு திரும்பு", currentRisk:"முன்கணிப்பு பாதுகாப்பு", hiddenSafety:"மறைக்கப்பட்ட/உள்ளூர் இட பாதுகாப்பு", closingSoon:"விரைவில் மூடப்படும்", verifyHours:"பயணத்திற்கு முன் உண்மையான நேரத்தை சரிபார்க்கவும்.", packageEstimate:"மதிப்பிடப்பட்ட தொகுப்பு செலவு", assumedPrices:"திட்டமிடல் மதிப்பீட்டு விலைகள்", stay:"தங்குமிடம்", food:"உணவு", localTransport:"உள்ளூர் போக்குவரத்து", entryFees:"நுழைவு / இதர", generatePackage:"நாள் வாரியான தொகுப்பு உருவாக்கு", days:"நாட்கள்", totalBudget:"மொத்த பட்ஜெட்", destinationRequired:"முதலில் இலக்கை தேர்வு செய்யவும்.", sourceRequired:"முதலில் தொடக்க இடத்தை தேர்வு செய்யவும்.", noStatePlaces:"இந்த மாவட்டத்திற்கு இடங்கள் இன்னும் இல்லை.", whereGo:"நீங்கள் எங்கு செல்ல விரும்புகிறீர்கள்?", realPlaces:"உண்மையான இடங்கள்", liveRecommendations:"நேரடி பரிந்துரைகள்", riskTitle:"பயண பாதுகாப்பு மதிப்பெண்", riskBasis:"தற்போதைய வானிலை, பேட்டரி, இணைப்பு மற்றும் வழி நிலையை அடிப்படையாகக் கொண்டது.", hazards:"தற்போதைய அபாயங்கள்", noHazards:"தற்போது பெரிய அபாயங்கள் கண்டறியப்படவில்லை.", planRoute:"பாதுகாப்பான வழியை திட்டமிடுங்கள்", planRouteHelp:"தொடக்க இடம் மற்றும் இலக்கை தேர்வு செய்யுங்கள் அல்லது GPS இடத்தை தொடக்க இடமாக பயன்படுத்துங்கள். தற்போதைய இடம் மற்றும் SOS க்கு அனுமதி தேவை.", notSelected:"தேர்வு செய்யப்படவில்லை", liveStatus:"நேரடி நிலை", nearbyArea:"அருகிலுள்ள தேடல் பகுதி", noResults:"அருகில் முடிவுகள் இல்லை.", directionsUnavailable:"இந்த வழிக்கான வழிகாட்டுதல் இல்லை."
    }
  };
  const t = (key: string) => labels[language]?.[key] || labels.en[key] || key;

  const voiceLocale = language === "te" ? "te-IN" : language === "hi" ? "hi-IN" : language === "ta" ? "ta-IN" : "en-IN";
  function speak(text: string) {
    if (!("speechSynthesis" in window)) { setMessage("Voice output is not supported by this browser."); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voiceLocale;
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
  }

  function speakCurrentScreen() {
    const destinationText = dest?.displayName?.text ? ` ${t("destination")}: ${dest.displayName.text}.` : "";
    const routeText = routes.length ? ` ${routes.length} ${t("routeOptions")} available.` : "";
    speak(`${t("home")}. ${t("risk")}: ${risk.score} out of 100.${destinationText}${routeText}`);
  }

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [recommendations, setRecommendations] = useState<Place[]>([]);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [selectedDistrict, setSelectedDistrict] = useState<string | null>(null);
  const [journeyMode, setJourneyMode] = useState(view === "journey");

  const [loc, setLoc] = useState<any>();
  const [source, setSource] = useState<Place>();
  const [dest, setDest] = useState<Place>();
  const [sourceQuery, setSourceQuery] = useState("");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [sourceResults, setSourceResults] = useState<Place[]>([]);
  const [destinationResults, setDestinationResults] = useState<Place[]>([]);
  const [destinationAttractions, setDestinationAttractions] = useState<Place[]>([]);
  const [routeAttractions, setRouteAttractions] = useState<Place[]>([]);
  const [tripStops, setTripStops] = useState<Place[]>(() => JSON.parse(localStorage.getItem("tg_trip_stops") || "[]"));
  const [routeAttractionsLoading, setRouteAttractionsLoading] = useState(false);
  const [fuelStationsLoading, setFuelStationsLoading] = useState(false);
  const [fuelStations, setFuelStations] = useState<Place[]>([]);
  const [stationFilter, setStationFilter] = useState<"all" | "fuel" | "ev_charging">("all");
  const [nearbyReference, setNearbyReference] = useState<"current" | "destination">("current");
  const [routeDestination, setRouteDestination] = useState<Place>();
  const [voiceListening, setVoiceListening] = useState<"source" | "destination" | "general" | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  useEffect(() => {
    if (initialSource) {
      setSource(initialSource);
      setSourceQuery(initialSource.displayName?.text || "");
    }
    if (initialDestination) {
      setDest(initialDestination);
      setDestinationQuery(initialDestination.displayName?.text || "");
      setRouteDestination(initialDestination);
    }
  }, [view, initialDestination?.id, initialSource?.id]);

  useEffect(() => {
    const savedRoutes = JSON.parse(localStorage.getItem("tg_selected_routes") || "null");
    if (Array.isArray(savedRoutes) && savedRoutes.length) setRoutes(savedRoutes);
  }, []);
  const [weather, setWeather] = useState<any>();
  const [nearby, setNearby] = useState<Place[]>([]);
  const [nearbyType, setNearbyType] = useState<string>(""); // tracks which button was pressed, for map pin icons
  const [showNearbyModal, setShowNearbyModal] = useState(false); // popup instead of scrolling to bottom
  const [expandedPlaceId, setExpandedPlaceId] = useState<string | number | null>(null); // which hotel card is showing price
  const mapSectionRef = useRef<HTMLDivElement>(null); // so we can scroll the map into view after picking a place

  // Previewing a nearby hospital/hotel/fuel/tourist place must NOT
  // navigate away from whatever screen the tourist is currently on —
  // only an explicit "Set as Destination" action should do that. This
  // state drives a small, view-independent preview panel that shows
  // the route to the tapped place without touching `dest`/`routes`.
  const [previewPlace, setPreviewPlace] = useState<Place | null>(null);
  const [previewRoute, setPreviewRoute] = useState<any[]>([]);
  const [previewRouteLoading, setPreviewRouteLoading] = useState(false);

  const [battery, setBattery] = useState<number | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [offlineReady, setOfflineReady] = useState(localStorage.getItem("tg_offline_ready") === "true");
  const [offlineDownloading, setOfflineDownloading] = useState(false);

  const savedJourney = JSON.parse(localStorage.getItem("tg_active_journey") || "null");
  const [journey, setJourney] = useState<any>(savedJourney || undefined);

  const savedRoutes = JSON.parse(localStorage.getItem("tg_selected_routes") || "[]");
  const [routes, setRoutes] = useState<any[]>(Array.isArray(savedRoutes) ? savedRoutes : []);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [showRouteResults, setShowRouteResults] = useState(Array.isArray(savedRoutes) && savedRoutes.length > 0);
  const [activeStep, setActiveStep] = useState(0);

  const [message, setMessage] = useState("");

  const [handshake, setHandshake] = useState(false);
  const [countdown, setCountdown] = useState(15);

  // --------------------------------------------------
  // DEDICATED POLICE / TRANSPORT SCREENS
  // --------------------------------------------------
  const [stationScreen, setStationScreen] = useState<
    "police" | "transport" | null
  >(null);
  const [stationLoading, setStationLoading] = useState(false);
  const [stationResults, setStationResults] = useState<
    (Place & { _distanceKm?: number; _kind?: string })[]
  >([]);
  const [nearestRoute, setNearestRoute] = useState<any[]>([]);
  const [nearestRouteLoading, setNearestRouteLoading] = useState(false);

  // --------------------------------------------------
  // LIVE ALERTS (battery / weather / off-route)
  // --------------------------------------------------
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  // SIMPLE LIVE RISK SCORE — based only on conditions already used by the app.
  const risk = useMemo(() => {
    let score = 0;
    const hazards: string[] = [];

    const condition = String(weather?.condition || "").toLowerCase();
    const severe = ["storm", "thunder", "cyclone", "hail", "heavy rain", "flood", "extreme"].some(k => condition.includes(k));
    const temp = Number(weather?.temperature);

    if (severe) { score += 30; hazards.push(`Severe weather: ${weather?.condition || "dangerous weather"}`); }
    else if (Number.isFinite(temp) && (temp >= 42 || temp <= 4)) { score += 15; hazards.push(`Extreme temperature: ${Math.round(temp)}°C`); }
    if (battery !== null && battery <= 10) { score += 10; hazards.push("Critical low battery"); }
    else if (battery !== null && battery <= 20) { score += 5; hazards.push("Low battery"); }
    if (!online) { score += 8; hazards.push("No network connection"); }
    if (alerts.some(a => a.id === "route")) { score += 20; hazards.push("Route deviation"); }
    if (alerts.some(a => a.id === "battery" && a.severity === "critical")) hazards.push("Live tracking may stop soon");
    score = Math.min(100, score);
    const level = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
    return { score, level, hazards };
  }, [weather, battery, online, alerts]);
  // ids the user has manually dismissed — condition still
  // holds, but we won't re-show until it clears and re-fires
  const dismissedAlerts = useRef<Set<string>>(new Set());

  function upsertAlert(alert: AlertItem) {
    if (dismissedAlerts.current.has(alert.id)) return;

    setAlerts((prev) => {
      const existing = prev.find((a) => a.id === alert.id);
      if (existing && existing.message === alert.message) return prev;
      return [...prev.filter((a) => a.id !== alert.id), alert];
    });
  }

  // condition returned to normal — clear it and allow it to
  // fire again next time it happens
  function clearAlertCondition(id: string) {
    dismissedAlerts.current.delete(id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }

  function dismissAlert(id: string) {
    dismissedAlerts.current.add(id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }

  // --------------------------------------------------
  // SIMPLIFIED TRIP PACKAGE INPUTS
  // (destination, days, total budget for the whole trip)
  // --------------------------------------------------
  const [days, setDays] = useState(3);
  const [totalBudget, setTotalBudget] = useState<number>(0);

  const savedTripPlan = JSON.parse(localStorage.getItem("tg_trip_plan") || "null");
  const savedPlanMatchesDestination = !!savedTripPlan && (!savedTripPlan.destinationId || savedTripPlan.destinationId === initialDestination?.id);
  const [itinerary, setItinerary] = useState<any>(savedPlanMatchesDestination ? savedTripPlan?.itinerary || null : null);
  const [itineraryLoading, setItineraryLoading] = useState(false);
  useEffect(() => {
    if (savedPlanMatchesDestination && savedTripPlan?.days) setDays(Number(savedTripPlan.days));
    if (savedPlanMatchesDestination && savedTripPlan?.totalBudget) setTotalBudget(Number(savedTripPlan.totalBudget));
  }, []);

  const lastSent = useRef(0);

  const perDayBudget = useMemo(
    () => (days > 0 ? Math.round(totalBudget / days) : 0),
    [totalBudget, days]
  );

  // --------------------------------------------------
  // REAL GPS + BATTERY + SAFETY SENSOR
  // --------------------------------------------------

  useEffect(() => {
    const stop = watchLocation(
      (l) => setLoc(l),
      (e) => setMessage(`Location unavailable: ${e.message}`)
    );

    readBattery().then((b) =>
      setBattery(b?.level ?? null)
    );

    const impactStop = startImpactMonitor(() =>
      startHandshake("POSSIBLE_IMPACT")
    );

    const onlineHandler = () => setOnline(true);
    const offHandler = () => setOnline(false);

    addEventListener("online", onlineHandler);
    addEventListener("offline", offHandler);

    return () => {
      stop();
      impactStop();

      removeEventListener("online", onlineHandler);
      removeEventListener("offline", offHandler);
    };
  }, []);

  // --------------------------------------------------
  // LIVE WEATHER
  // --------------------------------------------------

  useEffect(() => {
    if (!loc) return;

    const timer = setTimeout(() => {
      api
        .get("/weather", {
          params: {
            lat: loc.lat,
            lng: loc.lng
          }
        })
        .then((r) => setWeather(r.data))
        .catch(() => setWeather(null));
    }, 800);

    return () => clearTimeout(timer);
  }, [loc?.lat, loc?.lng]);

  // --------------------------------------------------
  // ALERT: LOW BATTERY
  // (battery is stored as a plain 0–100 percentage — see
  // LiveStatus, which renders it as `${battery}%`)
  // --------------------------------------------------

  useEffect(() => {
    if (battery === null) return;

    if (battery <= 10) {
      upsertAlert({
        id: "battery",
        severity: "critical",
        message: `🔋 Battery critically low (${battery}%) — live tracking and SOS may stop working soon. Charge now if possible.`
      });
    } else if (battery <= 20) {
      upsertAlert({
        id: "battery",
        severity: "warning",
        message: `🔋 Battery low (${battery}%) — consider turning on battery saver.`
      });
    } else {
      clearAlertCondition("battery");
    }
  }, [battery]);

  // --------------------------------------------------
  // ALERT: SEVERE / EXTREME WEATHER
  // --------------------------------------------------

  useEffect(() => {
    if (!weather) return;

    const condition = String(weather.condition || "").toLowerCase();
    const temp = weather.temperature;

    const severeKeywords = [
      "storm",
      "thunder",
      "cyclone",
      "hail",
      "heavy rain",
      "flood",
      "extreme"
    ];

    const isSevere = severeKeywords.some((k) => condition.includes(k));

    if (isSevere) {
      upsertAlert({
        id: "weather",
        severity: "critical",
        message: `⛈️ Severe weather nearby: ${weather.condition}. Consider postponing outdoor travel.`
      });
    } else if (typeof temp === "number" && (temp >= 42 || temp <= 4)) {
      upsertAlert({
        id: "weather",
        severity: "warning",
        message: `🌡️ Extreme temperature right now (${Math.round(
          temp
        )}°C) — stay hydrated / dress warmly.`
      });
    } else {
      clearAlertCondition("weather");
    }
  }, [weather]);

  // --------------------------------------------------
  // ALERT: OFF-ROUTE DETECTION
  // Decodes the active journey's route polyline once, then
  // checks the user's live GPS distance to that path on every
  // location update. Flags it if they've drifted too far.
  // --------------------------------------------------

  const routePath = useMemo(() => {
    const geometry = routes[selectedRoute]?.geometry?.coordinates;
    if (Array.isArray(geometry)) {
      return geometry
        .filter((p: any) => Array.isArray(p) && p.length >= 2)
        .map(([lng, lat]: [number, number]) => ({ lat: Number(lat), lng: Number(lng) }));
    }
    const encoded = routes[selectedRoute]?.polyline?.encodedPolyline;
    return encoded ? decodePolyline(encoded) : [];
  }, [routes, selectedRoute]);

  const OFF_ROUTE_THRESHOLD_KM = 0.3; // 300 m

  useEffect(() => {
    if (!journey || !loc || routePath.length < 2) {
      clearAlertCondition("route");
      return;
    }

    const offRouteKm = minDistanceToPathKm(loc, routePath);

    if (offRouteKm > OFF_ROUTE_THRESHOLD_KM) {
      upsertAlert({
        id: "route",
        severity: "warning",
        message: `🧭 You appear to be ~${Math.round(
          offRouteKm * 1000
        )} m off the planned route.`,
        actionLabel: "Recalculate route"
      });
    } else {
      clearAlertCondition("route");
    }
  }, [loc?.lat, loc?.lng, routePath, journey]);

  async function recalculateRoute() {
    if (!loc || !dest) return;

    try {
      const r = await api.post("/routes/compute", {
        origin: { lat: loc.lat, lng: loc.lng },
        destination: {
          lat: dest.location.latitude,
          lng: dest.location.longitude
        }
      });

      setRoutes(r.data.routes || []);
      setSelectedRoute(0);
      clearAlertCondition("route");

    } catch {
      setMessage("Live route recalculation unavailable");
    }
  }

  // --------------------------------------------------
  // SEND LIVE LOCATION TO JOURNEY
  // --------------------------------------------------

  useEffect(() => {
    if (!journey || !loc) return;

    if (Date.now() - lastSent.current < 4000) return;

    lastSent.current = Date.now();

    api
      .patch(`/journeys/${journey._id}/location`, {
        ...loc,
        battery,
        online
      })
      .then((r) => {
        if (r.data.restrictedZones?.length) {
          setMessage(
            `⚠️ Restricted zone: ${r.data.restrictedZones[0].name}`
          );
        }
      })
      .catch(() => {});
  }, [loc, journey, battery, online]);

  // --------------------------------------------------
  // SAFETY HANDSHAKE COUNTDOWN
  // --------------------------------------------------

  useEffect(() => {
    if (!handshake) return;

    setCountdown(15);

    const timer = setInterval(() => {
      setCountdown((v) => {
        if (v <= 1) {
          clearInterval(timer);
          escalateHandshake();
          return 0;
        }

        return v - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [handshake]);

  // --------------------------------------------------
  // SEARCH REAL PLACES
  // --------------------------------------------------

  async function search() {
    if (!q.trim()) return;

    try {
      const r = await api.get("/places/search", {
        params: {
          q,
          lat: loc?.lat,
          lng: loc?.lng
        }
      });

      const places = r.data.places || [];
      setResults(places);
      setRecommendations([]);
      localStorage.setItem("tg_last_search", JSON.stringify({ q, places, savedAt: Date.now() }));

    } catch {
      const cached = JSON.parse(localStorage.getItem("tg_last_search") || "null");
      if (cached?.places) {
        setResults(cached.places);
        setMessage("Offline mode: showing your last saved search.");
      } else setMessage("Live place search unavailable");
    }
  }

  // --------------------------------------------------
  // STATE DISCOVERY
  // --------------------------------------------------

  function selectState(s: string) {
    setSelectedState(s);
    setSelectedDistrict(null);
    setQ("");
    setResults([]);
    setRecommendations([]);
  }

  async function selectStatePlace(placeName: string, stateName: string) {
    setDestinationQuery(`${placeName}, ${stateName}`);
    try {
      const r = await api.get("/places/search", { params: { q: `${placeName}, ${stateName}` } });
      const place = r.data.places?.[0];
      if (place) {
        selectDestination(place);
      } else {
        setMessage("This place could not be located right now.");
      }
    } catch {
      setMessage("Live location search unavailable");
    }
  }

  // --------------------------------------------------
  // MANUAL SOURCE / DESTINATION ROUTE PLANNER
  // --------------------------------------------------

  async function searchRoutePlace(
    text: string,
    setResults: (places: Place[]) => void
  ) {
    if (!text.trim()) return;

    try {
      const r = await api.get("/places/search", {
        params: { q: text }
      });

      setResults(r.data.places || []);
    } catch {
      setResults([]);
      setMessage("Live location search unavailable");
    }
  }

  function selectSource(place: Place) {
    setSource(place);
    localStorage.setItem("tg_selected_source", JSON.stringify(place));
    setSourceQuery(place.displayName?.text || "");
    setSourceResults([]);
    setRoutes([]);
    setSelectedRoute(0);
    setShowRouteResults(false);
    setMessage("");
  }

  function swapSourceDestination() {
    const prevSource = source;
    const prevDest = dest;
    const prevSourceQuery = sourceQuery;
    const prevDestQuery = destinationQuery;

    setSource(prevDest);
    setDest(prevSource);
    setSourceQuery(prevDestQuery);
    setDestinationQuery(prevSourceQuery);
    setSourceResults([]);
    setDestinationResults([]);
    setRoutes([]);
    setSelectedRoute(0);
    setShowRouteResults(false);

    if (prevDest) localStorage.setItem("tg_selected_source", JSON.stringify(prevDest));
    else localStorage.removeItem("tg_selected_source");
    if (prevSource) localStorage.setItem("tg_selected_destination", JSON.stringify(prevSource));
    else localStorage.removeItem("tg_selected_destination");
  }

  async function useCurrentLocationAsSource() {
    try {
      setMessage("Requesting your current location permission...");
      const current = await getCurrentLocation();
      setLoc(current);

      const currentPlace: Place = {
        id: "current-location",
        displayName: { text: "My Current Location" },
        formattedAddress: `Current GPS location (accuracy ~${Math.round(current.accuracy)} m)`,
        location: {
          latitude: current.lat,
          longitude: current.lng
        }
      };

      setSource(currentPlace);
      localStorage.setItem("tg_selected_source", JSON.stringify(currentPlace));
      setSourceQuery("My Current Location");
      setSourceResults([]);
      setRoutes([]);
      setSelectedRoute(0);
      setMessage("Current location selected as source.");
    } catch (e: any) {
      setMessage(
        e?.code === 1
          ? "Location permission was denied. Allow location access in your browser and try again."
          : "Unable to get your current location. Please enable device location and try again."
      );
    }
  }

  async function findSelectedRoutes() {
    if (!source || !dest) {
      setMessage("Please select both source and destination");
      return;
    }

    const origin = {
      lat: Number(source.location.latitude),
      lng: Number(source.location.longitude)
    };

    const destination = {
      lat: Number(dest.location.latitude),
      lng: Number(dest.location.longitude)
    };

    if (origin.lat === destination.lat && origin.lng === destination.lng) {
      setMessage("Source and destination cannot be the same");
      return;
    }

    try {
      setRouteLoading(true);
      setMessage("");

      const r = await api.post("/routes/compute", {
        origin,
        destination
      });

      const calculatedRoutes = r.data.routes || [];
      setRoutes(calculatedRoutes);
      localStorage.setItem("tg_selected_routes", JSON.stringify(calculatedRoutes));
      setSelectedRoute(0);
      setShowRouteResults(calculatedRoutes.length > 0);

      if (!calculatedRoutes.length) {
        setMessage("No routes found between these locations");
      }
    } catch {
      setRoutes([]);
      setMessage("Live route data unavailable");
    } finally {
      setRouteLoading(false);
    }
  }


  // --------------------------------------------------
  // VOICE SEARCH — uses the browser's built-in speech
  // recognition when supported. The transcript is placed
  // into the same search field as typed search.
  // --------------------------------------------------
  function startVoiceSearch(target: "source" | "destination" | "general") {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setMessage("Voice search is not supported by this browser. Try Microsoft Edge or Google Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang =
      language === "te" ? "te-IN" :
      language === "hi" ? "hi-IN" :
      language === "ta" ? "ta-IN" : "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setVoiceListening(target);

    recognition.onresult = (event: any) => {
      const transcript = String(event.results?.[0]?.[0]?.transcript || "").trim();
      if (target === "source") {
        setSourceQuery(transcript);
        searchRoutePlace(transcript, setSourceResults);
      } else if (target === "destination") {
        setDestinationQuery(transcript);
        searchRoutePlace(transcript, setDestinationResults);
      } else {
        setQ(transcript);
        search();
      }
      setVoiceListening(null);
    };

    recognition.onerror = () => {
      setVoiceListening(null);
      setMessage("Voice search could not hear you. Please try again.");
    };

    recognition.onend = () => setVoiceListening(null);
    recognition.start();
  }

  // --------------------------------------------------
  // SELECT DESTINATION
  // --------------------------------------------------

  function selectDestination(place: Place) {
    setDest(place);
    localStorage.setItem("tg_selected_destination", JSON.stringify(place));
    setRouteDestination(place);
    setDestinationQuery(place.displayName?.text || "");
    setDestinationResults([]);
    setRoutes([]);
    setSelectedRoute(0);
    setNearby([]);
    setItinerary(null);
    setTripStops([]);
    localStorage.removeItem("tg_trip_stops");
    setMessage("");

    // Selecting a place must take the tourist directly to the destination screen.
    navigate("/destination", { state: { source, destination: place } });
  }

  // --------------------------------------------------
  // NEARBY REAL PLACES (generic — used by Hospitals / Hotels)
  // --------------------------------------------------

  function endpointReferences() {
    const refs: { key: "source" | "destination"; label: string; place?: Place }[] = [];
    if (source?.location) refs.push({ key: "source", label: source.displayName?.text || "Source", place: source });
    if (dest?.location) refs.push({ key: "destination", label: dest.displayName?.text || "Destination", place: dest });
    return refs;
  }

  async function searchNearbyAtReference(type: string, ref: { key: "source" | "destination"; label: string; place?: Place }) {
    const lat = Number(ref.place?.location?.latitude);
    const lng = Number(ref.place?.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const r = await api.get(type === "hotel" ? "/places/hotels" : "/places/nearby", { params: { type, lat, lng } });
    return (r.data.places || []).map((p: Place) => ({
      ...p,
      _reference: ref.key,
      _referenceLabel: ref.label,
      _distanceKm: p.location ? distanceKm({ lat, lng }, { lat: Number(p.location.latitude), lng: Number(p.location.longitude) }) : undefined
    }));
  }

  async function nearbySearch(type: string) {
    const refs = endpointReferences();
    if (!refs.length) {
      setMessage("Select a source and destination first.");
      return;
    }

    try {
      const batches = await Promise.allSettled(refs.map((ref) => searchNearbyAtReference(type, ref)));
      const merged = batches.flatMap((r) => r.status === "fulfilled" ? r.value : []);
      const unique = new Map<string, Place>();
      for (const p of merged) {
        const name = String(p.displayName?.text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
        const coord = p.location ? `${Number(p.location.latitude).toFixed(5)},${Number(p.location.longitude).toFixed(5)}` : "";
        const key = `${name}|${coord}`;
        if (!unique.has(key)) unique.set(key, p);
      }
      const places = Array.from(unique.values()).sort((a: any, b: any) => (a._distanceKm ?? Infinity) - (b._distanceKm ?? Infinity));
      setNearby(places);
      setNearbyType(type);
      setShowNearbyModal(true);
      setExpandedPlaceId(null);
      localStorage.setItem(`tg_nearby_${type}_endpoints`, JSON.stringify(places));
      if (!places.length) setMessage(`No ${type} found near the selected source or destination.`);
    } catch {
      const cached = JSON.parse(localStorage.getItem(`tg_nearby_${type}_endpoints`) || "null");
      if (cached) {
        setNearby(cached); setNearbyType(type); setShowNearbyModal(true); setMessage("Offline mode: showing saved source/destination results.");
      } else setMessage(`Live ${type} data unavailable.`);
    }
  }

  // --------------------------------------------------
  // APPROX PER-DAY HOTEL PRICE FROM GOOGLE'S priceLevel
  // (Google Places doesn't return exact nightly rates —
  // only a coarse tier. For real ₹ prices, connect a
  // hotel-pricing API like Booking.com/MakeMyTrip on the
  // backend and return it as p.priceRange from /places/nearby)
  // --------------------------------------------------

  function priceLevelToRange(level?: string) {
    switch (level) {
      case "PRICE_LEVEL_INEXPENSIVE":
        return "₹800 – ₹1,500 / day (approx)";
      case "PRICE_LEVEL_MODERATE":
        return "₹1,500 – ₹3,500 / day (approx)";
      case "PRICE_LEVEL_EXPENSIVE":
        return "₹3,500 – ₹7,000 / day (approx)";
      case "PRICE_LEVEL_VERY_EXPENSIVE":
        return "₹7,000+ / day (approx)";
      default:
        return null;
    }
  }

  function renderPriceInfo(p: Place) {
    // Prefer a real backend-provided price range if you add one
    if (p.priceRange?.startPrice && p.priceRange?.endPrice) {
      return (
        <b>
          💰 ₹{p.priceRange.startPrice.units} – ₹
          {p.priceRange.endPrice.units} / day
        </b>
      );
    }

    const approx = priceLevelToRange(p.priceLevel);

    if (approx) {
      return <b>💰 {approx}</b>;
    }

    return (
      <span className="muted">
        Live per-day price not available from this data source.
        Connect a hotel-pricing API (Booking.com/MakeMyTrip/Google Hotels)
        on the backend to show real ₹ rates here.
      </span>
    );
  }

  // --------------------------------------------------
  // NAVIGATE TO A NEARBY PLACE (map pin tap)
  // Reuses the same /routes/compute backend used by
  // startJourney, so safety score / traffic duration
  // all work the same way.
  // --------------------------------------------------

  // Preview a nearby place: stays on the current screen, draws the route
  // in a small floating panel, and never touches `dest`/`routes`/navigate.
  // This is deliberately separate from selectDestination()/navigate() —
  // see confirmPreviewAsDestination() below for the explicit "Set as
  // Destination" action.
  async function previewNearbyPlace(place: Place) {
    if (!place?.location) return;
    setShowNearbyModal(false); // close the results popup once a place is picked
    setPreviewPlace(place);
    setPreviewRoute([]);

    const ref = getNearbyReference();
    const origin = ref ? { lat: ref.lat, lng: ref.lng } : (loc ? { lat: loc.lat, lng: loc.lng } : null);
    if (!origin) {
      setMessage("Allow real location, or select a source/destination first, to calculate the route.");
      return;
    }

    setPreviewRouteLoading(true);
    try {
      const r = await api.post("/routes/compute", {
        origin,
        destination: {
          lat: place.location.latitude,
          lng: place.location.longitude
        }
      });
      setPreviewRoute(r.data.routes || []);
    } catch {
      setPreviewRoute([]);
      setMessage("Live route data unavailable");
    } finally {
      setPreviewRouteLoading(false);
    }
  }

  function closeNearbyPreview() {
    setPreviewPlace(null);
    setPreviewRoute([]);
  }

  // The one deliberate action that actually changes the trip destination
  // and takes the tourist to the destination screen.
  function confirmPreviewAsDestination() {
    if (!previewPlace) return;
    const place = previewPlace;
    setPreviewPlace(null);
    setPreviewRoute([]);
    selectDestination(place);
  }

  // --------------------------------------------------
  // POLICE — dedicated screen
  // Fetches real nearby police stations, sorts by actual
  // GPS distance (nearest first), and pre-computes the
  // route to the closest one so the map is useful immediately.
  // --------------------------------------------------

  async function openPoliceStations() {
    const refs = endpointReferences();
    if (!refs.length) { setMessage("Select a source and destination first."); return; }
    setStationScreen("police"); setStationLoading(true); setStationResults([]); setNearestRoute([]);
    try {
      const batches = await Promise.allSettled(refs.map((ref) => searchNearbyAtReference("police", ref)));
      const merged = batches.flatMap((r) => r.status === "fulfilled" ? r.value : []).map((p: Place) => ({ ...p, _kind: "police" }));
      const unique = new Map<string, any>();
      for (const p of merged) {
        const key = `${String(p.displayName?.text || "").toLowerCase()}|${p.location ? `${Number(p.location.latitude).toFixed(5)},${Number(p.location.longitude).toFixed(5)}` : ""}`;
        if (!unique.has(key)) unique.set(key, p);
      }
      const places = Array.from(unique.values()).sort((a: any, b: any) => (a._distanceKm ?? Infinity) - (b._distanceKm ?? Infinity));
      setStationResults(places);
      if (places[0]) fetchRouteToStation(places[0]);
    } catch { setMessage("Live police station data unavailable"); }
    finally { setStationLoading(false); }
  }

  // --------------------------------------------------
  // TRANSPORT — dedicated screen
  // Merges real nearby railway stations AND bus stands
  // into one list, sorted by actual GPS distance.
  // --------------------------------------------------

  async function openTransportStations() {
    const refs = endpointReferences();
    if (!refs.length) { setMessage("Select a source and destination first."); return; }
    setStationScreen("transport"); setStationLoading(true); setStationResults([]); setNearestRoute([]);
    try {
      const requests = refs.flatMap((ref) => [
        searchNearbyAtReference("train_station", ref).then((items) => items.map((p: Place) => ({ ...p, _kind: "train" }))),
        searchNearbyAtReference("bus_station", ref).then((items) => items.map((p: Place) => ({ ...p, _kind: "bus" })))
      ]);
      const batches = await Promise.allSettled(requests);
      const merged = batches.flatMap((r) => r.status === "fulfilled" ? r.value : []);
      const unique = new Map<string, any>();
      for (const p of merged) {
        const key = `${String(p.displayName?.text || "").toLowerCase()}|${p.location ? `${Number(p.location.latitude).toFixed(5)},${Number(p.location.longitude).toFixed(5)}` : ""}`;
        if (!unique.has(key)) unique.set(key, p);
      }
      const places = Array.from(unique.values()).sort((a: any, b: any) => (a._distanceKm ?? Infinity) - (b._distanceKm ?? Infinity));
      setStationResults(places);
      if (places[0]) fetchRouteToStation(places[0]);
    } catch { setMessage("Live transport data unavailable"); }
    finally { setStationLoading(false); }
  }

  // --------------------------------------------------
  // Compute + show the real route to a specific station
  // (called automatically for the nearest one, and again
  // whenever the user taps "Show route here" on another)
  // --------------------------------------------------

  async function fetchRouteToStation(place: Place) {
    if (!place?.location) return;
    const refPlace = place._reference === "source" ? source : place._reference === "destination" ? dest : undefined;
    const ref = refPlace?.location
      ? { lat: Number(refPlace.location.latitude), lng: Number(refPlace.location.longitude) }
      : getNearbyReference();
    if (!ref) return;

    setNearestRouteLoading(true);
    try {
      const r = await api.post("/routes/compute", {
        origin: { lat: ref.lat, lng: ref.lng },
        destination: { lat: Number(place.location.latitude), lng: Number(place.location.longitude) }
      });
      setNearestRoute(r.data.routes || []);
    } catch {
      setNearestRoute([]);
    } finally {
      setNearestRouteLoading(false);
    }
  }

  function closeStationScreen() {
    setStationScreen(null);
    setStationResults([]);
    setNearestRoute([]);
  }

  // --------------------------------------------------
  // START REAL GPS JOURNEY
  // --------------------------------------------------

  async function startJourney() {
    if (!dest) {
      setMessage("Select a destination first.");
      return;
    }

    // A journey always needs live GPS permission, even if the user
    // selected a manual source, because journey tracking/SOS use the
    // tourist's real current position.
    let journeyLocation = loc;
    if (!journeyLocation) {
      try {
        journeyLocation = await getCurrentLocation();
        setLoc(journeyLocation);
      } catch {
        setMessage("Location permission is required to start a live journey.");
        return;
      }
    }

    try {
      const j = await api.post("/journeys", {
        source: {
          placeId: source?.id,
          name: source?.displayName?.text,
          address: source?.formattedAddress,
          lat: source?.location?.latitude,
          lng: source?.location?.longitude
        },
        destination: {
          placeId: dest.id,
          name: dest.displayName?.text,
          address: dest.formattedAddress,
          lat: dest.location.latitude,
          lng: dest.location.longitude
        },
        consentedTracking: true
      });

      setJourney(j.data);
      localStorage.setItem("tg_active_journey", JSON.stringify(j.data));

      const r = await api.post("/routes/compute", {
        origin: {
          lat: Number(source?.location?.latitude ?? journeyLocation.lat),
          lng: Number(source?.location?.longitude ?? journeyLocation.lng)
        },
        destination: {
          lat: dest.location.latitude,
          lng: dest.location.longitude
        }
      });

      const journeyRoutes = r.data.routes || [];
      setRoutes(journeyRoutes);
      setSelectedRoute(0);
      setShowRouteResults(journeyRoutes.length > 0);
      if (journeyRoutes.length > 0) { setJourneyMode(true); navigate("/journey"); }

    } catch {
      setMessage(
        "Live journey/route data unavailable"
      );
    }
  }


  function emergencyMessage() {
    const route = routes[selectedRoute];
    const score = route?.safetyScore ?? risk.score;
    const hazards = risk.hazards.join(", ");
    if (language === "te") return `అత్యవసర సహాయం కావాలి. భద్రతా స్కోర్ ${score}/100. ప్రమాదాలు: ${hazards || "ప్రత్యేక సమాచారం లేదు"}`;
    if (language === "hi") return `आपातकालीन सहायता चाहिए। सुरक्षा स्कोर ${score}/100। जोखिम: ${hazards || "कोई विशेष जानकारी नहीं"}`;
    if (language === "ta") return `அவசர உதவி தேவை. பாதுகாப்பு மதிப்பெண் ${score}/100. அபாயங்கள்: ${hazards || "குறிப்பிட்ட தகவல் இல்லை"}`;
    return `Emergency assistance required. Safety score ${score}/100. Hazards: ${hazards || "No specific hazard recorded"}`;
  }

  // --------------------------------------------------
  // SOS
  // --------------------------------------------------

  async function sendSOS() {
    // SOS always uses a fresh real GPS reading. This also triggers
    // the browser location permission prompt if permission has not
    // been granted yet.
    let sosLocation = loc;

    try {
      const fresh = await getCurrentLocation();
      sosLocation = fresh;
      setLoc(fresh);
    } catch (e: any) {
      setMessage(
        e?.code === 1
          ? "Location permission is required to send SOS. Please allow location access and try again."
          : "Unable to get your current location. SOS requires a real GPS location."
      );
      return;
    }

    if (!sosLocation) {
      setMessage("Real current location is required for SOS");
      return;
    }

    if (
      !confirm(
        "SEND SOS with your current location?"
      )
    ) {
      return;
    }

    try {
      await api.post("/emergency", {
        type: "MANUAL_SOS",
        journeyId: journey?._id,
        lat: sosLocation.lat,
        lng: sosLocation.lng,
        trigger: "MANUAL_SOS",
        metadata: {
          battery,
          online,
          riskScore: risk.score,
          riskLevel: risk.level,
          hazards: risk.hazards,
          language,
          translatedMessage: emergencyMessage()
        }
      });

      setMessage(
        "🚨 SOS event sent to the authority dashboard."
      );

    } catch {
      setMessage("Offline: SOS could not reach the authority server. Your emergency contact can still be called.");
    }

    const savedUser = JSON.parse(localStorage.getItem("tg_user") || "null");
    const contact = savedUser?.trustedContact;
    if (contact?.phone && confirm(`Call ${contact.name || "your emergency contact"} now?`)) {
      window.location.href = `tel:${contact.phone}`;
    }
  }

  // --------------------------------------------------
  // SAFETY HANDSHAKE
  // --------------------------------------------------

  function startHandshake(trigger: string) {
    if (handshake) return;

    setHandshake(true);

    setMessage(
      `⚠️ ${trigger.split("_").join(" ")} detected. Are you OK?`
    );
  }

  async function escalateHandshake() {
    setHandshake(false);

    if (!loc) return;

    try {
      if (journey?._id) {
        await api.post(
          `/journeys/${journey._id}/handshake`,
          {
            lat: loc.lat,
            lng: loc.lng,
            trigger:
              "POSSIBLE_IMPACT_NO_RESPONSE",
            battery,
            online,
            language,
            translatedMessage: emergencyMessage()
          }
        );
      } else {
        await api.post("/emergency", {
          type: "UNRESPONSIVE_HANDSHAKE",
          lat: loc.lat,
          lng: loc.lng,
          trigger:
            "POSSIBLE_IMPACT_NO_RESPONSE",
          metadata: {
            battery,
            online,
            riskScore: risk.score,
            riskLevel: risk.level,
            hazards: risk.hazards,
            language,
            translatedMessage: emergencyMessage()
          }
        });
      }

      setMessage(
        "Possible emergency escalated to the authority dashboard."
      );

    } catch {
      setMessage(
        "Emergency escalation unavailable."
      );
    }
  }

  function cancelHandshake() {
    setHandshake(false);

    setMessage(
      "Safety check cancelled — marked as safe."
    );
  }

  // --------------------------------------------------
  // GENERATE DAY-WISE TRIP PACKAGE
  // Only two real inputs: number of days + total budget
  // for the whole trip. Everything else (per-day split,
  // places for each day) is computed / fetched live.
  // --------------------------------------------------

  async function buildItinerary() {
    if (!dest) { setMessage(t("destinationRequired")); return; }
    if (!days || days < 1 || days > 7) { setMessage("Enter a valid number of days (1–7)"); return; }
    if (!totalBudget || totalBudget <= 0) { setMessage("Enter your total trip budget"); return; }

    setItineraryLoading(true);
    try {
      const r = await api.post("/planner/itinerary", {
        destination: dest.displayName?.text || dest.formattedAddress,
        days,
        budget: totalBudget,
        selectedPlaces: tripStops
      });
      const data = r.data;
      setItinerary(data);
      localStorage.setItem(`tg_itinerary_${dest.id || dest.displayName?.text}`, JSON.stringify(data));
      localStorage.setItem("tg_trip_plan", JSON.stringify({ itinerary: data, days, totalBudget, destinationId: dest.id }));
      setMessage(data.uniquePlaceCount ? `Generated ${days}-day plan using ${data.uniquePlaceCount} unique places.` : "Trip plan generated.");
    } catch (e: any) {
      setMessage(e?.response?.data?.message || "Live itinerary generation unavailable. Please try again.");
    } finally {
      setItineraryLoading(false);
    }
  }

  function toggleAddToTrip(place: Place) {
    const key = String(place.id || `${place.displayName?.text}|${place.location?.latitude}|${place.location?.longitude}`);
    setTripStops((prev) => {
      const exists = prev.some((p: any) => String(p.id || `${p.displayName?.text}|${p.location?.latitude}|${p.location?.longitude}`) === key);
      const next = exists ? prev.filter((p: any) => String(p.id || `${p.displayName?.text}|${p.location?.latitude}|${p.location?.longitude}`) !== key) : [...prev, place];
      localStorage.setItem("tg_trip_stops", JSON.stringify(next));
      return next;
    });
  }

  // --------------------------------------------------
  // BUDGET PLANNING BREAKDOWN
  // Splits the trip into Stay / Food / Local transport /
  // Misc, matching the "Estimated cost (per person)" card.
  // It always sums to the user's own total budget:
  //   - If the itinerary suggested a real place to stay and
  //     Google returned a priceLevel for it, that place's
  //     approx nightly rate is used for the Stay line.
  //   - Everything else is the remaining budget split across
  //     Food / Local transport / Misc using a standard
  //     travel-budget ratio (42% / 25% / 33% of what's left),
  //     since there's no live per-item price source for those
  //     categories yet.
  //   - If the backend's /planner/itinerary response already
  //     includes its own `budgetBreakdown` array, that real
  //     data is used instead and nothing here is estimated.
  // --------------------------------------------------

  type BudgetLine = { label: string; amount: number; note: string };

  function priceLevelToPerNight(level?: string): number | null {
    switch (level) {
      case "PRICE_LEVEL_INEXPENSIVE":
        return 1150;
      case "PRICE_LEVEL_MODERATE":
        return 2500;
      case "PRICE_LEVEL_EXPENSIVE":
        return 5250;
      case "PRICE_LEVEL_VERY_EXPENSIVE":
        return 8000;
      default:
        return null;
    }
  }

  function computeBudgetBreakdown(): BudgetLine[] | null {
    if (!itinerary || !totalBudget || !days) return null;
    const b = itinerary?.budget?.breakdown;
    if (b) {
      return [
        { label: t("stay"), amount: Number(b.accommodation || 0), note: "Estimated accommodation allocation" },
        { label: t("food"), amount: Number(b.food || 0), note: "Estimated food allocation" },
        { label: t("localTransport"), amount: Number(b.localTransport || 0), note: "Estimated local transport" },
        { label: "Sightseeing", amount: Number(b.sightseeing || 0), note: "Estimated entry / activity costs" },
        { label: "Fuel / EV", amount: Number(b.fuelOrEvCharging || 0), note: "Estimated fuel or charging" },
        { label: "Miscellaneous", amount: Number(b.miscellaneous || 0), note: "Estimated contingency / other" }
      ];
    }
    const stayTotal = Math.round(totalBudget * 0.35);
    const foodTotal = Math.round(totalBudget * 0.22);
    const transportTotal = Math.round(totalBudget * 0.15);
    const sightseeingTotal = Math.round(totalBudget * 0.12);
    const fuelTotal = Math.round(totalBudget * 0.10);
    const miscTotal = Math.max(totalBudget - stayTotal - foodTotal - transportTotal - sightseeingTotal - fuelTotal, 0);
    return [
      { label: t("stay"), amount: stayTotal, note: `₹${Math.round(stayTotal / days).toLocaleString("en-IN")}/day` },
      { label: t("food"), amount: foodTotal, note: `₹${Math.round(foodTotal / days).toLocaleString("en-IN")}/day` },
      { label: t("localTransport"), amount: transportTotal, note: `₹${Math.round(transportTotal / days).toLocaleString("en-IN")}/day` },
      { label: "Sightseeing", amount: sightseeingTotal, note: "Estimated" },
      { label: "Fuel / EV", amount: fuelTotal, note: "Estimated" },
      { label: "Miscellaneous", amount: miscTotal, note: "Estimated" }
    ];
  }

  async function downloadForOffline() {
    if (!dest) {
      setMessage("Select a destination first.");
      return;
    }

    setOfflineDownloading(true);
    setMessage("⏳ Downloading this trip for offline use…");

    // Store the complete trip snapshot first. This is what the destination
    // screen reads when the network is unavailable.
    const snapshot = {
      destination: dest,
      itinerary,
      nearby,
      routes,
      weather,
      downloadedAt: Date.now()
    };
    localStorage.setItem("tg_offline_destination", JSON.stringify(snapshot));

    try {
      if (!("serviceWorker" in navigator) || !("caches" in window)) {
        throw new Error("Offline storage is unavailable in this browser");
      }

      // Make sure the service worker is registered and controlling this page.
      const registration = await navigator.serviceWorker.ready;
      if (!registration.active) throw new Error("Service worker is not active");

      // Cache every same-origin resource that is already loaded by the app.
      // We cache both the exact URL and the URL without Vite/HMR query strings,
      // so the saved app can be reopened after the network is switched off.
      const cache = await caches.open("tourism-guardian-v5");
      const resources = Array.from(new Set(
        performance.getEntriesByType("resource")
          .map((entry: any) => entry.name as string)
          .filter((url: string) => url.startsWith(window.location.origin))
          .concat([
            `${window.location.origin}/`,
            `${window.location.origin}/index.html`,
            `${window.location.origin}/destination`,
            `${window.location.origin}/profile`,
            `${window.location.origin}/manifest.webmanifest`,
            `${window.location.origin}/sw.js`
          ])
      ));

      let cachedCount = 0;
      for (const raw of resources) {
        try {
          const url = new URL(raw);
          if (url.origin !== window.location.origin) continue;

          const response = await fetch(url.href, { cache: "no-store" });
          if (!response.ok) continue;
          await cache.put(url.href, response.clone());

          // Also save a clean URL. Vite dev mode can append timestamps/query
          // parameters, but offline navigation needs the clean module URL.
          if (url.search || url.hash) {
            url.search = "";
            url.hash = "";
            await cache.put(url.href, response.clone());
          }
          cachedCount++;
        } catch (_) {
          // One unavailable resource must not prevent the remaining app from
          // being downloaded.
        }
      }

      // Ask the service worker to warm its own cache as well. This also keeps
      // production/preview builds working with the same offline mechanism.
      registration.active.postMessage({
        type: "CACHE_OFFLINE",
        urls: resources
      });

      // Verify the most important offline files before telling the user that
      // the download succeeded.
      const hasHome = !!(await cache.match("/"));
      const hasIndex = !!(await cache.match("/index.html"));
      const hasMain = resources.some(raw => {
        try {
          const u = new URL(raw);
          return /\/src\/main\.tsx$|\/assets\/index-.*\.js$/.test(u.pathname);
        } catch { return false; }
      });

      if (!hasHome && !hasIndex) throw new Error("App shell was not cached");
      if (cachedCount < 1 && !hasMain) throw new Error("App resources were not cached");

      localStorage.setItem("tg_offline_ready", "true");
      localStorage.setItem("tg_offline_downloaded_at", String(Date.now()));
      setOfflineReady(true);
      setMessage("✓ Downloaded successfully. This trip is ready to use offline even when the network is off.");
    } catch (error) {
      console.error("Offline download failed", error);
      setOfflineReady(false);
      localStorage.removeItem("tg_offline_ready");
      setMessage("⚠️ Offline download could not complete. Keep the network on and tap Download for offline again.");
    } finally {
      setOfflineDownloading(false);
    }
  }

  useEffect(() => {
    if (view !== "destination") return;
    const cached = JSON.parse(localStorage.getItem("tg_offline_destination") || "null");
    if (cached?.destination && (!navigator.onLine || !initialDestination)) {
      setDest(cached.destination);
      if (cached.itinerary) setItinerary(cached.itinerary);
      if (cached.nearby) setNearby(cached.nearby);
      if (cached.routes) setRoutes(cached.routes);
      if (cached.weather) setWeather(cached.weather);
      setMessage("Offline mode: using your pre-downloaded trip data.");
    }
  }, [view]);


  // --------------------------------------------------
  // DESTINATION ATTRACTIONS
  // Discover famous/local tourist attractions near the
  // selected destination. Their route is calculated only
  // when the user chooses one.
  // --------------------------------------------------
  useEffect(() => {
    if (!(view === "destination" || view === "places") || !dest?.location) return;

    api.get("/places/destination-attractions", {
      params: {
        lat: dest.location.latitude,
        lng: dest.location.longitude
      }
    }).then((r) => {
      setDestinationAttractions(r.data.places || []);
    }).catch(() => setDestinationAttractions([]));
  }, [view, dest?.id]);

  useEffect(() => {
    if (!(view === "destination" || view === "places" || view === "fuel") || !routes[selectedRoute]?.geometry?.coordinates?.length) {
      setRouteAttractions([]);
      setRouteAttractionsLoading(false);
      return;
    }
    setRouteAttractionsLoading(true);
    api.post("/places/along-route-attractions", { coordinates: routes[selectedRoute].geometry.coordinates })
      .then((r) => {
        const places = (r.data.places || []).map((p:any) => ({
          ...p,
          _currentDistanceKm: loc && p.location ? distanceKm(loc, { lat:Number(p.location.latitude), lng:Number(p.location.longitude) }) : undefined
        }));
        setRouteAttractions(places);
      })
      .catch(() => setRouteAttractions([]))
      .finally(() => setRouteAttractionsLoading(false));
  }, [view, routes, selectedRoute]);

  async function selectAttraction(place: Place) {
    if (!source?.location || !place?.location) {
      setMessage("A source location is required to calculate attraction routes.");
      return;
    }

    try {
      setMessage(`Finding safe routes to ${place.displayName?.text || "this place"}...`);
      const r = await api.post("/routes/compute", {
        origin: {
          lat: Number(source.location.latitude),
          lng: Number(source.location.longitude)
        },
        destination: {
          lat: Number(place.location.latitude),
          lng: Number(place.location.longitude)
        }
      });

      setRoutes(r.data.routes || []);
      setSelectedRoute(0);
      setShowRouteResults((r.data.routes || []).length > 0);
      setRouteDestination(place);
      setMessage(`Showing alternative routes to ${place.displayName?.text || "selected attraction"}.`);
      mapSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      setMessage("Safe routes to this attraction are currently unavailable.");
    }
  }

  // --------------------------------------------------
  // LIVE TURN-BY-TURN PROGRESS
  // Only the current and next maneuver are shown. The next
  // instruction changes as the tourist moves with GPS.
  // --------------------------------------------------
  useEffect(() => {
    const steps = routes[selectedRoute]?.steps || [];
    if (!steps.length || !loc) { setActiveStep(0); return; }
    let best = 0;
    let bestDistance = Infinity;
    steps.forEach((step:any, i:number) => {
      if (!step.location) return;
      const d = distanceKm(loc, { lat: Number(step.location.latitude ?? step.location.lat), lng: Number(step.location.longitude ?? step.location.lng) });
      if (d < bestDistance) { bestDistance = d; best = i; }
    });
    // If we are close to the current maneuver, move the active card to the next maneuver.
    setActiveStep(Math.min(steps.length - 1, bestDistance < 0.06 ? best + 1 : best));
  }, [loc?.lat, loc?.lng, routes, selectedRoute]);

  // --------------------------------------------------
  // FUEL STATIONS ALONG SELECTED ROUTE
  // --------------------------------------------------
  useEffect(() => {
    if (!routes[selectedRoute]?.geometry?.coordinates?.length) {
      setFuelStations([]);
      setFuelStationsLoading(false);
      return;
    }

    setFuelStationsLoading(true);
    api.post("/places/along-route", {
      coordinates: routes[selectedRoute].geometry.coordinates,
      types: ["fuel", "ev_charging"]
    }).then((r) => {
      const places = (r.data.places || []).map((p:any) => ({
        ...p,
        _currentDistanceKm: loc && p.location ? distanceKm(loc, {lat:Number(p.location.latitude), lng:Number(p.location.longitude)}) : undefined
      })).sort((a:any,b:any) => (a._currentDistanceKm ?? Infinity) - (b._currentDistanceKm ?? Infinity));
      setFuelStations(places);
    }).catch(() => setFuelStations([]))
      .finally(() => setFuelStationsLoading(false));
  }, [journey, selectedRoute, routes, loc?.lat, loc?.lng]);

  function getNearbyReference() {
    if (nearbyReference === "destination" && dest?.location) {
      return {
        lat: Number(dest.location.latitude),
        lng: Number(dest.location.longitude),
        label: dest.displayName?.text || "Destination"
      };
    }
    if (loc) return { lat: loc.lat, lng: loc.lng, label: "Current location" };
    return null;
  }

  // --------------------------------------------------
  // ALERT: PLANNED CLOSING / VISIT WINDOW
  // Uses the package's assumed visit window; it never claims
  // to be a verified live opening-hours feed.
  // --------------------------------------------------
  useEffect(() => {
    const checkClosing = () => {
      if (!itinerary?.itinerary) { clearAlertCondition("closing"); return; }
      const now = new Date();
      let soon: any = null;
      for (const day of itinerary.itinerary) {
        for (const stop of day.stops || []) {
          const end = String(stop.closingTime || stop.time || "").split(" - ").pop();
          const m = end?.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (!m) continue;
          let h = Number(m[1]); const min = Number(m[2]); const ap = m[3].toUpperCase();
          if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
          const close = new Date(now); close.setHours(h, min, 0, 0);
          const diff = close.getTime() - now.getTime();
          if (diff >= 0 && diff <= 60 * 60 * 1000) { soon = { name: stop.place?.displayName?.text || "Tourist place" }; break; }
        }
        if (soon) break;
      }
      if (soon) upsertAlert({ id: "closing", severity: "warning", message: `🔴 ${soon.name} — ${t("closingSoon")}. ${t("verifyHours")}` });
      else clearAlertCondition("closing");
    };
    checkClosing();
    const timer = window.setInterval(checkClosing, 60_000);
    return () => window.clearInterval(timer);
  }, [itinerary, language]);

  useEffect(() => {
    setJourneyMode(view === "journey");
  }, [view]);

  // --------------------------------------------------
  // UI
  // --------------------------------------------------

  return (
    <div className={`app view-${view}`}>

      {/* HEADER */}
      <header>
        <div>
          <b>🛡️ Tourism Guardian</b>

          <small>
            Explore Freely. Travel Safely.
          </small>
        </div>

        <div className="header-actions">
          <button onClick={() => navigate("/")}>{t("home")}</button>
          <button onClick={() => navigate("/profile")}>👤 {t("profile")}</button>
          <button type="button" onClick={speakCurrentScreen} title={t("listen")}>🔊 {t("listen")}</button>
          <select value={language} onChange={e => { setLanguage(e.target.value); window.speechSynthesis?.cancel(); }} aria-label="Language">
            <option value="en">English</option>
            <option value="te">తెలుగు</option>
            <option value="hi">हिन्दी</option>
            <option value="ta">தமிழ்</option>
          </select>
          <span>{user?.name}</span>
          <button onClick={() => useAuth.getState().logout()}>{t("logout")}</button>
        </div>
      </header>

      <main>

        {/* LIVE RISK SCORE + HAZARDS */}
        <section className="card risk-card">
          <div className="risk-head">
            <div>
              <h2 style={{margin:"0 0 5px"}}>🛡️ {t("riskTitle")}</h2>
              <p className="muted" style={{margin:0}}>{t("riskBasis")}</p>
            </div>
            <div className={`risk-badge ${risk.level.toLowerCase()}`}>{risk.score}/100 · {risk.level}</div>
          </div>
          <div className="risk-bar"><div style={{width:`${risk.score}%`}} /></div>
          {risk.hazards.length > 0 ? (
            <div className="hazards">
              <b>⚠️ {t("hazards")}</b>
              {risk.hazards.map((h,i)=><span key={i}>• {h}</span>)}
            </div>
          ) : <p className="muted" style={{marginBottom:0}}>{t("noHazards")}</p>}
        </section>

        {/* LIVE ALERTS — battery / weather / off-route */}
        {alerts.length > 0 && (

          <div
            className="alerts"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              marginBottom: "18px"
            }}
          >

            {alerts.map((a) => (

              <div
                key={a.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                  padding: "12px 16px",
                  borderRadius: "10px",
                  background:
                    a.severity === "critical" ? "#4c0519" : "#422006",
                  border: `1px solid ${
                    a.severity === "critical" ? "#f43f5e" : "#f59e0b"
                  }`,
                  color: "#fff"
                }}
              >

                <span style={{ fontWeight: 600 }}>{a.message}</span>

                <div
                  style={{
                    display: "flex",
                    gap: "14px",
                    alignItems: "center"
                  }}
                >

                  {a.id === "route" && (
                    <button
                      onClick={recalculateRoute}
                      style={{
                        color: "#fff",
                        fontWeight: 700,
                        background: "rgba(255,255,255,0.15)",
                        border: "none",
                        borderRadius: "6px",
                        padding: "6px 10px",
                        cursor: "pointer"
                      }}
                    >
                      {a.actionLabel || "Recalculate"}
                    </button>
                  )}

                  <button
                    onClick={() => dismissAlert(a.id)}
                    style={{
                      color: "#fff",
                      background: "none",
                      border: "none",
                      fontWeight: 700,
                      cursor: "pointer"
                    }}
                  >
                    ✕
                  </button>

                </div>

              </div>

            ))}

          </div>

        )}

        {view === "home" && <>
        {/* SIMPLE TRIP SETUP — first screen after login */}
        <section className="card" style={{ marginBottom: "16px" }}>
          <h1 style={{ marginTop: 0 }}>🧭 {t("plan")}</h1>
          <p className="muted">
            {language === "te"
              ? "ముందుగా Source మరియు Destination ఎంచుకోండి. Source కోసం GPS లేదా search ఉపయోగించవచ్చు."
              : language === "hi"
              ? "पहले Source और Destination चुनें. Source के लिए GPS या search का उपयोग करें."
              : language === "ta"
              ? "முதலில் தொடக்க இடம் மற்றும் இலக்கை தேர்வு செய்யுங்கள். தொடக்க இடத்திற்கு GPS அல்லது தேடலை பயன்படுத்தலாம்."
              : "Choose your source and destination first. Source can be your GPS location or a searched place."}
          </p>

          <div style={{ display: "grid", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontWeight: 800, marginBottom: 6 }}>📍 {t("source")}</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={sourceQuery}
                  onChange={e => setSourceQuery(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && searchRoutePlace(sourceQuery, setSourceResults)}
                  placeholder={t("searchSource")}
                  style={{ flex: 1, minWidth: 220, padding: 12, borderRadius: 8, border: "1px solid #cbd5e1" }}
                />
                <button type="button" className="primary" onClick={() => searchRoutePlace(sourceQuery, setSourceResults)}>
                  🔎 {t("search")}
                </button>
                <button type="button" onClick={() => startVoiceSearch("source")} title="Voice source search">
                  {voiceListening === "source" ? "🎙️ Listening…" : "🎙️ Voice"}
                </button>
                <button type="button" onClick={useCurrentLocationAsSource}>
                  📍 {t("currentLocation")}
                </button>
              </div>
              {sourceResults.length > 0 && (
                <div className="results" style={{ marginTop: 8 }}>
                  {sourceResults.map(p => (
                    <button key={p.id} type="button" onClick={() => selectSource(p)}>
                      <b>{p.displayName?.text}</b><span>{p.formattedAddress}</span>
                    </button>
                  ))}
                </div>
              )}
              {source && <div className="muted" style={{ marginTop: 6 }}>✓ {source.displayName?.text}</div>}
            </div>

            <div>
              <label style={{ display: "block", fontWeight: 800, marginBottom: 6 }}>⭐ {t("destination")}</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={destinationQuery}
                  onChange={e => setDestinationQuery(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && searchRoutePlace(destinationQuery, setDestinationResults)}
                  placeholder={t("searchDestination")}
                  style={{ flex: 1, minWidth: 220, padding: 12, borderRadius: 8, border: "1px solid #cbd5e1" }}
                />
                <button type="button" className="primary" onClick={() => searchRoutePlace(destinationQuery, setDestinationResults)}>
                  🔎 {t("search")}
                </button>
                <button type="button" onClick={() => startVoiceSearch("destination")} title="Voice destination search">
                  {voiceListening === "destination" ? "🎙️ Listening…" : "🎙️ Voice"}
                </button>
              </div>
              {destinationResults.length > 0 && (
                <div className="results" style={{ marginTop: 8 }}>
                  {destinationResults.map(p => (
                    <button key={p.id} type="button" onClick={() => selectDestination(p)}>
                      <b>{p.displayName?.text}</b><span>{p.formattedAddress}</span></button>
                  ))}
                </div>
              )}
              {dest && <div className="muted" style={{ marginTop: 6 }}>✓ {dest.displayName?.text}</div>}
            </div>
          </div>

          {source && dest && (
            <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "#f8fafc" }}>
              <b>✓ {source.displayName?.text}</b> → <b>{dest.displayName?.text}</b>
              <button
                type="button"
                className="primary"
                style={{ width: "100%", marginTop: 10 }}
                onClick={() => navigate("/destination", { state: { source, destination: dest } })}
              >
                🗺️ {t("findRoutes")}
              </button>
            </div>
          )}
        </section>

        {/* SEARCH */}
        <section className="hero card">

          <h1>{t("whereGo")}</h1>

          <div className="search">

            <input
              value={q}
              onChange={(e) =>
                setQ(e.target.value)
              }
              onKeyDown={(e) =>
                e.key === "Enter" && search()
              }
              placeholder="Search any real place..."
            />

            <button
              className="primary"
              onClick={search}
            >
              Search
            </button>

          </div>

          <select
            value={selectedState || ""}
            onChange={(e) => e.target.value && selectState(e.target.value)}
            aria-label={t("selectState")}
          >
            <option value="">{t("selectState")}</option>
            {states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

        </section>


        {/* STATE DISCOVERY — clicking a state opens its places instead of using the state itself as a destination */}
        {selectedState && (
          <section className="card state-discovery">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div>
                <h2 style={{margin:"0 0 4px"}}>🗺️ {selectedState}</h2>
                <p className="muted" style={{margin:0}}>{t("statePlaces")}</p>
              </div>
              <button type="button" onClick={() => {setSelectedState(null); setSelectedDistrict(null);}}>{t("back")}</button>
            </div>
            <div className="state-districts">
              {Object.entries(statePlaces[selectedState] || {}).map(([district, places]) => (
                <article key={district} className={selectedDistrict === district ? "state-district selected" : "state-district"}>
                  <button type="button" className="district-title" onClick={() => setSelectedDistrict(selectedDistrict === district ? null : district)}>📍 {district}</button>
                  {(selectedDistrict === null || selectedDistrict === district) && (
                    <div className="state-place-list">
                      {places.map((place) => (
                        <button key={place} type="button" onClick={() => selectStatePlace(place, selectedState)}>
                          <b>{place}</b><span>{selectedState}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <p className="muted" style={{marginBottom:0}}>🔴 {t("hiddenSafety")}: local/less-crowded attractions can have less safety information. Avoid isolated areas after dark and keep a charged phone.</p>
          </section>
        )}

        {/* LIVE RECOMMENDATIONS */}
        {recommendations.length > 0 && (

          <section className="card">

            <h2>⭐ {t("liveRecommendations")}</h2>

            <div className="results">

              {recommendations.map((p) => (

                <button
                  key={p.id}
                  onClick={() =>
                    selectDestination(p)
                  }
                >

                  <b>
                    {p.displayName?.text}
                  </b>

                  <span>
                    {p.formattedAddress}
                  </span>

                </button>

              ))}

            </div>

          </section>

        )}


        {/* SEARCH RESULTS */}
        {results.length > 0 && (

          <section className="card">

            <h2>{t("realPlaces")}</h2>

            <div className="results">

              {results.map((p) => (

                <button
                  key={p.id}
                  onClick={() =>
                    selectDestination(p)
                  }
                >

                  <b>
                    {p.displayName?.text}
                  </b>

                  <span>
                    {p.formattedAddress}
                  </span>

                  {p.rating && (
                    <span>
                      ⭐ {p.rating}
                    </span>
                  )}

                </button>

              ))}

            </div>

          </section>

        )}


        </>}

        {(view === "destination" || view === "planner") && <>

        {/* MANUAL SOURCE + DESTINATION ROUTE PLANNER */}
        <section className="card route-screen" style={{ marginBottom: "16px" }}>
          <div className="screen-nav">
            <button type="button" className="primary" onClick={() => navigate("/destination")}>🧭 Route</button>
            <button type="button" onClick={() => navigate("/places")}>📍 Nearby & Tourist Places</button>
            <button type="button" onClick={() => navigate("/fuel")}>⛽ Filling Stations</button>
            <button type="button" onClick={() => navigate("/planner")}>🧳 Trip Planner</button>
          </div>
          <h2>🧭 {t("planRoute")}</h2>
          <p className="muted">{t("planRouteHelp")}</p>

          <div style={{ display: "grid", gap: "10px" }}>
            <div className="route-location-field">
              <label className="route-location-label"><span className="loc-icon">📍</span> {t("source")}</label>
              <div className="route-location-row">
                <div className="route-location-input-wrap">
                  <span className="loc-icon-inline">📍</span>
                  <input
                    value={sourceQuery}
                    onChange={(e) => setSourceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") searchRoutePlace(sourceQuery, setSourceResults);
                    }}
                    placeholder="Search source location..."
                    className="route-location-input source-input"
                  />
                </div>
                <button className="primary" type="button" onClick={() => searchRoutePlace(sourceQuery, setSourceResults)}>Search</button>
                <button type="button" onClick={() => startVoiceSearch("source")}>🎙️ {t("voice")}</button>
                <button type="button" onClick={useCurrentLocationAsSource} style={{ padding: "11px 14px", border: "1px solid #16a34a", borderRadius: "8px", background: "#f0fdf4", color: "#166534", fontWeight: 700, cursor: "pointer" }}>
                  📍 Use My Current Location
                </button>
              </div>
              {sourceResults.length > 0 && (
                <div className="location-suggestions">
                  {sourceResults.map((p) => (
                    <button key={p.id} type="button" className="location-suggestion-item" onClick={() => selectSource(p)}>
                      <b>{p.displayName?.text || "Unknown place"}</b><br />
                      <small>{p.formattedAddress}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="route-swap-row">
              <button
                type="button"
                className="route-swap-btn"
                title="Swap source and destination"
                aria-label="Swap source and destination"
                onClick={swapSourceDestination}
                disabled={!source && !dest}
              >
                ⇅
              </button>
            </div>

            <div className="route-location-field">
              <label className="route-location-label"><span className="loc-icon">⭐</span> {t("destination")}</label>
              <div className="route-location-row">
                <div className="route-location-input-wrap">
                  <span className="loc-icon-inline">⭐</span>
                  <input
                    value={destinationQuery}
                    onChange={(e) => setDestinationQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") searchRoutePlace(destinationQuery, setDestinationResults);
                    }}
                    placeholder="Search destination location..."
                    className="route-location-input destination-input"
                  />
                </div>
                <button className="primary" type="button" onClick={() => searchRoutePlace(destinationQuery, setDestinationResults)}>Search</button>
                <button type="button" onClick={() => startVoiceSearch("destination")}>🎙️ {t("voice")}</button>
              </div>
              {destinationResults.length > 0 && (
                <div className="location-suggestions">
                  {destinationResults.map((p) => (
                    <button key={p.id} type="button" className="location-suggestion-item" onClick={() => selectDestination(p)}>
                      <b>{p.displayName?.text || "Unknown place"}</b><br />
                      <small>{p.formattedAddress}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="route-summary">
            <div><b>{t("source")}:</b> <span>{source?.displayName?.text || t("notSelected")}</span></div>
            <div><b>{t("destination")}:</b> <span>{dest?.displayName?.text || t("notSelected")}</span></div>
          </div>

          <button
            className="primary"
            type="button"
            onClick={findSelectedRoutes}
            disabled={!source || !dest || routeLoading}
            style={{ width: "100%", marginTop: "12px" }}
          >
            {routeLoading ? "Finding routes..." : "🛣️ Find Available Routes + Risk Scores"}
          </button>
        </section>

        {/* Everything below (map, live status, nearby hospitals/police/
            hotels/transport, fuel & tourist-attraction lists) is part of
            the Route/Destination screen only. The Trip Planner screen
            (view === "planner") intentionally does not show any of this —
            it only needs the destination picked above plus its own
            days/budget/itinerary UI further down. */}
        {view === "destination" && <>

        {/* MAP + LIVE STATUS */}
        <div className="grid route-screen">

          <section className="card" ref={mapSectionRef}>

            <h2>
              📍 Live map
            </h2>

            <MapView
              location={
                source?.location
                  ? {
                      lat: source.location.latitude,
                      lng: source.location.longitude
                    }
                  : loc
              }
              currentLocation={loc}
              destination={
                (routeDestination || dest)
                  ? {
                      lat: (routeDestination || dest).location.latitude,
                      lng: (routeDestination || dest).location.longitude
                    }
                  : undefined
              }
              routes={showRouteResults ? routes : []}
              showAlternatives={true}
              selectedRoute={selectedRoute}
              language={language}
              // nearby hotels/hospitals/police/train as tappable pins
              places={[
                ...nearby.filter((p) => p?.location).map((p) => ({
                  id: p.id,
                  lat: p.location.latitude,
                  lng: p.location.longitude,
                  name: p.displayName?.text || "Place",
                  category: nearbyType,
                  address: p.formattedAddress
                })),
                ...fuelStations.filter((p) => p?.location).map((p) => ({
                  id: `fuel-${p.id}`,
                  lat: p.location.latitude,
                  lng: p.location.longitude,
                  name: `⛽ ${p.displayName?.text || "Fuel station"}`,
                  category: "fuel",
                  address: p.formattedAddress
                }))
              ]}
              // tapping a pin computes + draws the real route to it
              onPlaceClick={(mapPlace) => {
                const original = nearby.find((p) => p.id === mapPlace.id);
                if (original) { previewNearbyPlace(original); return; }
                const fuel = fuelStations.find((p) => `fuel-${p.id}` === mapPlace.id);
                if (fuel) previewNearbyPlace(fuel);
              }}
            />

            <p className="muted">

              {loc
                ? `GPS accuracy: ${Math.round(
                    loc.accuracy
                  )} m`
                : "Waiting for real device GPS permission..."
              }

            </p>

          </section>


          {/* LIVE STATUS */}
          <section className="card">

            <h2>
              🛡️ Live status
            </h2>

            <LiveStatus
              battery={battery}
              online={online}
            />

            <div className="weather">

              {weather ? (

                <>
                  <b>
                    🌦️{" "}
                    {Math.round(
                      weather.temperature
                    )}°C
                  </b>

                  <span>
                    {weather.condition}
                  </span>

                  <small>
                    Updated:{" "}
                    {new Date(
                      weather.updatedAt
                    ).toLocaleTimeString()}
                  </small>
                </>

              ) : (

                <span>
                  Live weather unavailable
                </span>

              )}

            </div>

            <div style={{ marginTop: "12px" }}>
              <b>📍 {t("nearbyArea")}</b>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
                <button
                  type="button"
                  className={nearbyReference === "current" ? "primary" : ""}
                  onClick={() => setNearbyReference("current")}
                >
                  📍 {t("current")}
                </button>
                <button
                  type="button"
                  className={nearbyReference === "destination" ? "primary" : ""}
                  onClick={() => setNearbyReference("destination")}
                  disabled={!dest}
                >
                  ⭐ {t("nearbyDestination")}
                </button>
              </div>
            </div>

            <div className="actions">

              <button
                onClick={() => nearbySearch("hospital")}
              >
                🏥 {t("hospitals")}
              </button>

              <button
                onClick={openPoliceStations}
              >
                👮 {t("police")}
              </button>

              <button
                onClick={() =>
                  nearbySearch("hotel")
                }
              >
                🏨 {t("hotels")}
              </button>

              <button
                onClick={openTransportStations}
              >
                🚆 {t("transport")}
              </button>

            </div>

          </section>

        </div>


        {/* MAP-SYNCED NEARBY LISTS — same places are visible on the map and below it */}
        <section className="card map-place-lists places-screen">
          <div className="map-list-grid">
            <div>
              <h3>📍 {t("nearbyPlaces")}</h3>
              {nearby.length ? nearby.slice(0, 12).map((p: any) => (
                <button className="map-list-item" key={p.id} type="button" onClick={() => previewNearbyPlace(p)}>
                  <span><b>{p.displayName?.text || "Place"}</b><small>{p.formattedAddress || ""}</small></span><span>🧭</span>
                </button>
              )) : <p className="muted">{t("noNearby")}</p>}
            </div>
            <div>
              <h3>⛽ {t("fillingStations")}</h3>
              {fuelStations.length ? fuelStations.slice(0, 12).map((p: any) => (
                <button className="map-list-item" key={p.id} type="button" onClick={() => previewNearbyPlace(p)}>
                  <span><b>{p.displayName?.text || "Fuel station"}</b><small>{p.formattedAddress || ""}</small></span><span>{typeof p._routeDistanceKm === "number" ? `${p._routeDistanceKm.toFixed(1)} km` : "⛽"}</span>
                </button>
              )) : <p className="muted">{t("noFuel")}</p>}
            </div>
          </div>
        </section>

        {/* FAMOUS / LOCAL ATTRACTIONS NEAR DESTINATION */}
        {dest && destinationAttractions.length > 0 && (
          <section className="card places-screen">
            <h2>⭐ {t("attractions")}</h2>
            <p className="muted">
              {language === "te" ? "గమ్యం దగ్గర ఉన్న ప్రదేశాలను ఎంచుకోండి. ప్రతి ప్రదేశానికి సురక్షిత మార్గాలు లెక్కించబడతాయి."
                : language === "hi" ? "गंतव्य के पास कोई स्थान चुनें. उसके लिए सुरक्षित वैकल्पिक मार्ग दिखाए जाएंगे."
                : language === "ta" ? "இலக்கிற்கு அருகிலுள்ள இடத்தை தேர்வு செய்யுங்கள். அதற்கான பாதுகாப்பான மாற்று வழிகள் காட்டப்படும்."
                : "Choose an attraction near your destination. Alternative routes and safety scores will be calculated for it."}
            </p>
            <div className="results">
              {destinationAttractions.slice(0, 10).map((p: Place) => (
                <button key={p.id} type="button" onClick={() => selectAttraction(p)}>
                  <b>{p.displayName?.text || "Tourist place"}</b>
                  <span>{p.formattedAddress}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* DESTINATION + ROUTES */}
        {dest && (

          <section className="card route-screen">

            <h2>
              🧭{" "}
              {dest.displayName?.text}
            </h2>

            <p>
              {dest.formattedAddress}
            </p>

            <button className="offline-btn" onClick={downloadForOffline} disabled={offlineDownloading}>
              📥 {offlineDownloading ? "Downloading…" : offlineReady ? "Downloaded for offline" : t("download")}
            </button>
            {offlineReady && (
              <div className="offline-success">
                ✓ Downloaded successfully — this trip and the app are saved for offline use.
              </div>
            )}

            <button
              className="primary"
              onClick={startJourney}
            >
              🚀 {t("startJourney")}
            </button>


            {/* ROUTES */}
            {showRouteResults && routes.length > 0 && (

              <div
                style={{
                  marginTop: "18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px"
                }}
              >

                {routes.map((r, i) => (

                  <button
                    key={i}
                    onClick={() =>
                      setSelectedRoute(i)
                    }
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "7px",
                      width: "100%",
                      padding: "18px",
                      border:
                        i === selectedRoute
                          ? "2px solid #0088cc"
                          : "1px solid #cbd5e1",
                      borderRadius: "14px",
                      background:
                        i === selectedRoute
                          ? "#eaf7ff"
                          : "#ffffff",
                      color: "#071525",
                      cursor: "pointer",
                      textAlign: "left",
                      boxSizing: "border-box",
                      boxShadow:
                        "0 2px 8px rgba(0,0,0,0.08)"
                    }}
                  >

                    <strong
                      style={{ color: "#071525", fontSize: "19px", fontWeight: 800, display:"flex", alignItems:"center", gap:"8px" }}
                    >
                      <span style={{width:14,height:14,borderRadius:"50%",background:["#2563eb","#7c3aed","#db2777","#0891b2","#ea580c","#16a34a"][i%6],display:"inline-block"}} />
                      🛣️ {t("route")} {i + 1}
                    </strong>

                    <span
                      style={{
                        color: "#172033",
                        fontSize: "16px",
                        fontWeight: 600
                      }}
                    >
                      📍{" "}
                      {(
                        r.distanceMeters /
                        1000
                      ).toFixed(1)}{" "}
                      km
                    </span>

                    <span
                      style={{
                        color: "#263548",
                        fontSize: "14px",
                        fontWeight: 500
                      }}
                    >
                      🚗 Traffic-aware:{" "}
                      {Math.round(
                        Number.parseFloat(
                          String(r.duration).replace(
                            "s",
                            ""
                          )
                        ) / 60
                      )}{" "}
                      min
                    </span>

                    <span
                      style={{
                        color: "#263548",
                        fontSize: "14px",
                        fontWeight: 500
                      }}
                    >
                      🛣️ Normal:{" "}
                      {Math.round(
                        Number.parseFloat(
                          String(
                            r.staticDuration
                          ).replace("s", "")
                        ) / 60
                      )}{" "}
                      min
                    </span>

                    <strong
                      style={{
                        color: "#047857",
                        fontSize: "15px",
                        fontWeight: 800,
                        marginTop: "3px"
                      }}
                    >
                      🛡️{" "}
                      {r.safetyScore}/100 —{" "}
                      {r.safetyLabel}
                    </strong>
                    <span style={{ fontSize: "13px", fontWeight: 700 }}>
                      🔮 {t("next30")}: {r.predictiveRiskProbability30Min ?? (100 - Number(r.safetyScore || 0))}% probability · {r.predictiveRiskLevel30Min || "LOW"}
                    </span>
                    {r.predictiveSafetyNote30Min && (
                      <span className="muted" style={{ fontSize: "12px" }}>
                        {r.predictiveSafetyNote30Min}
                      </span>
                    )}

                  </button>

                ))}

              </div>

            )}

          </section>

        )}


        {/* PREDICTIVE + HIDDEN-ATTRACTION SAFETY */}
        {dest && (
          <section className="card safety-context-card route-screen">
            <h2>🔮 {t("currentRisk")}</h2>
            <p><b>{t("next30")}:</b> {routes[selectedRoute]?.predictiveRiskProbability30Min ?? Math.max(0, 100 - risk.score)}% probability · {routes[selectedRoute]?.predictiveRiskLevel30Min || risk.level}</p>
            <p className="muted">{routes[selectedRoute]?.predictiveSafetyNote30Min || "Prediction uses currently available weather, route and configured restricted-zone signals."}</p>
            <div className="hidden-safety-note"><b>🔴 {t("hiddenSafety")}</b><br/>Local or less-crowded attractions may have limited safety information. If an area becomes isolated, especially after 6 PM, leave early, stay with your group and keep emergency access available. This is precautionary guidance, not a claim of incident reports.</div>
          </section>
        )}

        {/* JOURNEY SAFETY */}
        {journey && (

          <section className="card journey-safety-screen">

            <h2>
              🛡️ Journey Safety Mode
            </h2>

            <p>
              Real GPS tracking is active only
              for this consented journey.
            </p>
            {fuelStations.length > 0 && (
              <p className="muted">⛽ {fuelStations.length} filling station(s) are shown on the selected route map.</p>
            )}

            <div className="danger-row">

              <button
                className="sos"
                onClick={sendSOS}
              >
                🚨 SEND SOS
              </button>

              <button
                onClick={() =>
                  api
                    .patch(
                      `/journeys/${journey._id}/end`
                    )
                    .then(() => {

                      setJourney(null);
                      localStorage.removeItem("tg_active_journey");
                      setRoutes([]);
                      setShowRouteResults(false);

                      setMessage(
                        "Journey ended."
                      );

                    })
                }
              >
                END JOURNEY
              </button>

              <button
                onClick={() =>
                  startHandshake(
                    "SAFETY CHECK"
                  )
                }
              >
                🛡️ TEST SAFETY CHECK
              </button>

            </div>

          </section>

        )}


        {/* NEARBY PLACES POPUP (Hospitals / Hotels) */}
        {showNearbyModal && (

          <div
            className="modal"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(4, 10, 24, 0.92)",
              zIndex: 3000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              overflowY: "auto"
            }}
          >

            <div
              className="card"
              style={{
                width: "100%",
                maxWidth: "560px",
                maxHeight: "85vh",
                overflowY: "auto"
              }}
            >

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <h2 style={{ margin: 0 }}>
                  Nearby: {nearbyType}
                </h2>

                <button onClick={() => setShowNearbyModal(false)}>
                  ✕ Close
                </button>
              </div>

              {nearby.length === 0 && (
                <p className="muted">{t("noResults")}</p>
              )}

              <div className="results">

                {nearby.map((p) => {
                  const isHotel = nearbyType === "hotel";
                  const isExpanded = expandedPlaceId === p.id;

                  return (
                    <div
                      key={p.id}
                      className="place"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                        width: "100%"
                      }}
                    >

                      {/* for hotels, tapping the name toggles price info
                          instead of navigating immediately */}
                      <button
                        onClick={() =>
                          isHotel
                            ? setExpandedPlaceId(isExpanded ? null : p.id)
                            : previewNearbyPlace(p)
                        }
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: "4px",
                          width: "100%",
                          textAlign: "left"
                        }}
                      >
                        <b>{p.displayName?.text}</b>
                        <span>{p.formattedAddress}</span>
                        {p.rating && <span>⭐ {p.rating}</span>}
                      </button>

                      {/* per-day price, shown only for hotels once tapped */}
                      {isHotel && isExpanded && (
                        <div
                          style={{
                            background: "#0b1728",
                            padding: "10px 12px",
                            borderRadius: "8px"
                          }}
                        >
                          {renderPriceInfo(p)}
                        </div>
                      )}

                      {p.nationalPhoneNumber && (
                        <a href={`tel:${p.nationalPhoneNumber}`}>CALL</a>
                      )}

                      {/* Preview stays on this screen and just draws the
                          route in the floating preview panel below. */}
                      <button
                        onClick={() => previewNearbyPlace(p)}
                        style={{
                          alignSelf: "flex-start",
                          color: "#0088cc",
                          fontWeight: 700,
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer"
                        }}
                      >
                        🧭 Preview route
                      </button>

                    </div>
                  );
                })}

              </div>

            </div>

          </div>

        )}


        {/* POLICE / TRANSPORT DEDICATED SCREEN */}
        {stationScreen && (

          <div
            className="modal"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(4, 10, 24, 0.95)",
              zIndex: 3100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              overflowY: "auto"
            }}
          >

            <div
              className="card"
              style={{
                width: "100%",
                maxWidth: "720px",
                maxHeight: "90vh",
                overflowY: "auto"
              }}
            >

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <h2 style={{ margin: 0 }}>
                  {stationScreen === "police"
                    ? "👮 Nearest Police Stations"
                    : "🚉 Nearest Transport (Railway & Bus)"}
                </h2>

                <button onClick={closeStationScreen}>
                  ✕ Close
                </button>
              </div>

              {stationLoading && (
                <p className="muted">
                  Fetching live{" "}
                  {stationScreen === "police"
                    ? "police stations"
                    : "railway stations and bus stands"}
                  ...
                </p>
              )}

              {!stationLoading && stationResults.length === 0 && (
                <p className="muted">
                  No{" "}
                  {stationScreen === "police"
                    ? "police stations"
                    : "railway stations or bus stands"}{" "}
                  found nearby.
                </p>
              )}

              {/* MAP TO NEAREST STATION */}
              {stationResults.length > 0 && (

                <div style={{ marginTop: "14px", marginBottom: "18px" }}>

                  <MapView
                    location={stationResults[0]?._reference === "source" ? source?.location : stationResults[0]?._reference === "destination" ? dest?.location : loc}
                    destination={
                      stationResults[0]?.location
                        ? {
                            lat: stationResults[0].location.latitude,
                            lng: stationResults[0].location.longitude
                          }
                        : undefined
                    }
                    routes={nearestRoute}
                    selectedRoute={0}
                    language={language}
                    places={stationResults
                      .filter((p) => p.location)
                      .map((p) => ({
                        id: p.id,
                        lat: p.location.latitude,
                        lng: p.location.longitude,
                        name:
                          p.displayName?.text ||
                          (p._kind === "bus"
                            ? "Bus stand"
                            : p._kind === "train"
                            ? "Railway station"
                            : "Police station"),
                        category: stationScreen,
                        address: p.formattedAddress
                      }))}
                    onPlaceClick={(mapPlace) => {
                      const original = stationResults.find(
                        (p) => p.id === mapPlace.id
                      );
                      if (original) fetchRouteToStation(original);
                    }}
                  />

                  <p className="muted" style={{ marginTop: "6px" }}>
                    {nearestRouteLoading
                      ? "Calculating route…"
                      : nearestRoute[0]
                      ? `🧭 ${(
                          nearestRoute[0].distanceMeters / 1000
                        ).toFixed(1)} km, ~${Math.round(
                          Number.parseFloat(
                            String(nearestRoute[0].duration).replace(
                              "s",
                              ""
                            )
                          ) / 60
                        )} min by road`
                      : "Live route data unavailable"}
                  </p>

                </div>

              )}

              {/* LIST — sorted nearest first */}
              <div
                className="results"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px"
                }}
              >

                {stationResults.map((p, i) => (

                  <div
                    key={p.id}
                    className="place"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                      width: "100%",
                      border:
                        i === 0
                          ? "2px solid #0088cc"
                          : "1px solid #334155",
                      borderRadius: "10px",
                      padding: "12px"
                    }}
                  >

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: "8px",
                        flexWrap: "wrap"
                      }}
                    >
                      <b>
                        {p._kind === "bus"
                          ? "🚌 "
                          : p._kind === "train"
                          ? "🚉 "
                          : "👮 "}
                        {p.displayName?.text}
                        {i === 0 && (
                          <span
                            style={{
                              marginLeft: "8px",
                              fontSize: "12px",
                              color: "#0088cc",
                              fontWeight: 700
                            }}
                          >
                            NEAREST
                          </span>
                        )}
                      </b>

                      {typeof p._distanceKm === "number" && (
                        <span
                          style={{
                            fontWeight: 700,
                            color: "#38bdf8"
                          }}
                        >
                          {p._distanceKm.toFixed(1)} km away
                        </span>
                      )}
                    </div>

                    <span>{p.formattedAddress}</span>
                    {p._referenceLabel && <span className="endpoint-badge">📍 {p._referenceLabel}</span>}

                    <div
                      style={{
                        display: "flex",
                        gap: "16px",
                        marginTop: "6px",
                        flexWrap: "wrap",
                        alignItems: "center"
                      }}
                    >
                      {p.nationalPhoneNumber ? (
                        <a
                          href={`tel:${p.nationalPhoneNumber}`}
                          style={{
                            color: "#22c55e",
                            fontWeight: 700,
                            textDecoration: "none"
                          }}
                        >
                          📞 {p.nationalPhoneNumber}
                        </a>
                      ) : (
                        <span className="muted">
                          No contact number in live data
                        </span>
                      )}

                      <button
                        onClick={() => fetchRouteToStation(p)}
                        style={{
                          color: "#0088cc",
                          fontWeight: 700,
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer"
                        }}
                      >
                        🗺️ Show route here
                      </button>

                      <button
                        onClick={() => {
                          selectDestination(p);
                          closeStationScreen();
                        }}
                        style={{
                          color: "#0088cc",
                          fontWeight: 700,
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer"
                        }}
                      >
                        🧭 Navigate on main map
                      </button>
                    </div>

                  </div>

                ))}

              </div>

            </div>

          </div>

        )}


        {/* TRIP PACKAGES — simplified: destination + days + total budget only */}
        </>}

        {view === "planner" && (
        <section className="card packages-card planner-screen">

          <div className="screen-nav">
            <button type="button" onClick={() => navigate("/destination")}>🧭 Route</button>
            <button type="button" onClick={() => navigate("/places")}>📍 Nearby & Tourist Places</button>
            <button type="button" onClick={() => navigate("/fuel")}>⛽ Filling Stations</button>
            <button type="button" className="primary" onClick={() => navigate("/planner")}>🧳 Trip Planner</button>
          </div>
          <h2>
            🧳 {t("plan")}
          </h2>

          <p className="muted" style={{ marginTop: 0 }}>
            {dest
              ? `${t("destination")}: ${dest.displayName?.text}`
              : t("destinationRequired")}
          </p>

          <div className="package-form">

            <label>
              {t("days")}
              <input
                type="number"
                min="1"
                max="7"
                value={days}
                onChange={(e) =>
                  setDays(Math.max(1, Number(e.target.value)))
                }
              />
            </label>

            <label>
              {t("totalBudget")} (₹)
              <input
                type="number"
                min="0"
                value={totalBudget || ""}
                placeholder="e.g. 15000"
                onChange={(e) =>
                  setTotalBudget(Number(e.target.value))
                }
              />
            </label>

          </div>

          {tripStops.length > 0 && (
            <div className="trip-stops-summary">⭐ {tripStops.length} place{tripStops.length === 1 ? "" : "s"} added to your trip. They will be prioritized in the next generated plan.</div>
          )}

          {totalBudget > 0 && days > 0 && (
            <p className="muted" style={{ marginTop: "4px" }}>
              ≈ ₹{perDayBudget.toLocaleString("en-IN")} / day
            </p>
          )}

          <button
            className="primary"
            onClick={buildItinerary}
            disabled={itineraryLoading}
          >
            {itineraryLoading
              ? "Generating…"
              : t("generatePackage")}
          </button>

          {itinerary && (

            <div className="itinerary" style={{ marginTop: "20px" }}>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: "6px",
                  marginBottom: "12px"
                }}
              >
                <h3 style={{ margin: 0 }}>
                  {days}-Day Package · {dest?.displayName?.text}
                </h3>

                <span style={{ fontWeight: 800 }}>
                  Total: ₹{totalBudget.toLocaleString("en-IN")} · ≈ ₹{Math.round(totalBudget / Math.max(1, days)).toLocaleString("en-IN")}/day
                </span>
              </div>

              {itinerary.itinerary.map((d: any) => {
                const dayDistanceKm = d.stops.reduce(
                  (sum: number, s: any) =>
                    sum +
                    (s.routeFromPrevious
                      ? s.routeFromPrevious.distanceMeters / 1000
                      : 0),
                  0
                );

                return (

                  <article
                    key={d.day}
                    style={{
                      border: "1px solid #334155",
                      borderRadius: "12px",
                      padding: "16px",
                      marginBottom: "12px"
                    }}
                  >

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "8px",
                        marginBottom: "10px"
                      }}
                    >
                      <h4 style={{ margin: 0 }}>
                        📅 Day {d.day}
                      </h4>

                      <span style={{ fontWeight: 700, color: "#047857" }}>
                        {typeof d.estimatedCost === "number" ? `₹${d.estimatedCost.toLocaleString("en-IN")}` : `₹${perDayBudget.toLocaleString("en-IN")}`} estimated
                        {dayDistanceKm > 0 &&
                          ` · ${dayDistanceKm.toFixed(0)} km`}
                      </span>
                    </div>

                    <div className="itinerary-meta">
                      <span>🚗 {d.transport}</span>
                      <span>🏨 {d.stay}</span>
                      {d.lunch && <span>🍴 {d.lunch.note}</span>}
                    </div>

                    {d.stops.length === 0 && (
                      <p className="muted">
                        No places returned for this day — try a broader
                        destination or fewer days.
                      </p>
                    )}

                    {d.stops.map((s: any) => (

                      <div className="place" key={s.place.id}>

                        <b>📍 {s.place.displayName?.text}</b>

                        <span>{s.place.formattedAddress}</span>

                        {s.time && <small>⏰ {s.time}</small>}
                        {s.duration && <small>⌛ {s.duration}</small>}
                        {s.tip && <small className="muted">💡 {s.tip}</small>}

                        {s.routeFromPrevious && (
                          <small>
                            🚗{" "}
                            {Math.round(
                              s.routeFromPrevious.distanceMeters / 1000
                            )}{" "}
                            km from previous stop
                          </small>
                        )}

                      </div>

                    ))}

                    {d.safetyTip && <div className="itinerary-safety">🛡️ {d.safetyTip}</div>}

                  </article>

                );
              })}

            </div>

          )}

          {/* BUDGET PLANNING — Estimated cost (per person) */}
          {(() => {
            const budgetLines = computeBudgetBreakdown();
            if (!budgetLines) return null;

            return (
              <div
                style={{
                  marginTop: "18px",
                  background: "#0b1f24",
                  borderRadius: "14px",
                  padding: "20px",
                  color: "#fff"
                }}
              >
                <h3 style={{ margin: "0 0 14px 0" }}>
                  💰 {t("packageEstimate")}
                </h3>

                {budgetLines.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "10px",
                      padding: "10px 0",
                      borderBottom:
                        i < budgetLines.length - 1
                          ? "1px solid rgba(255,255,255,0.12)"
                          : "none"
                    }}
                  >
                    <span>{line.label}</span>
                    <span style={{ fontWeight: 700, textAlign: "right" }}>
                      ₹{line.amount.toLocaleString("en-IN")} · {line.note}
                    </span>
                  </div>
                ))}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "10px",
                    paddingTop: "12px",
                    borderTop: "1px solid rgba(255,255,255,0.25)"
                  }}
                >
                  <span style={{ color: "#f59e0b", fontWeight: 800 }}>
                    Total ({t("totalBudget")})
                  </span>
                  <span style={{ color: "#f59e0b", fontWeight: 800 }}>
                    ₹{totalBudget.toLocaleString("en-IN")}
                  </span>
                </div>

                <p
                  className="muted"
                  style={{ marginTop: "10px", marginBottom: 0 }}
                >
                  {t("assumedPrices")} — fixed planning assumptions, not live quotations.
                </p>
              </div>
            );
          })()}

          <p className="muted">🧾 {t("assumedPrices")}: the package uses fixed planning assumptions rather than live hotel/food/transport quotations.</p>

        </section>
        )}

        </>}

        {/* SEPARATE NEARBY / TOURIST PLACES SCREEN */}
        {view === "places" && (
          <section className="card places-screen standalone-screen">
            <div className="screen-nav">
              <button type="button" onClick={() => navigate("/destination")}>🧭 Route</button>
              <button type="button" className="primary" onClick={() => navigate("/places")}>📍 Nearby & Tourist Places</button>
              <button type="button" onClick={() => navigate("/fuel")}>⛽ Filling Stations</button>
              <button type="button" onClick={() => navigate("/planner")}>🧳 Trip Planner</button>
            </div>
            <p className="muted">Discover attractions and useful stops along your selected journey.</p>
            {routes[selectedRoute]?.geometry?.coordinates?.length ? (
              <div className="route-summary">
                <div><b>{source?.displayName?.text || t("source")}</b> → <b>{dest?.displayName?.text || t("destination")}</b></div>
                <div>{(routes[selectedRoute].distanceMeters / 1000).toFixed(0)} km · {routes[selectedRoute].duration}</div>
              </div>
            ) : (
              <p className="state-note">Select a source, destination and route first to see places along your journey.</p>
            )}
            <MapView
              location={loc || source?.location}
              currentLocation={loc}
              destination={dest?.location ? {lat: dest.location.latitude, lng: dest.location.longitude} : undefined}
              routes={showRouteResults ? routes : []}
              selectedRoute={selectedRoute}
              language={language}
              places={[
                ...routeAttractions.filter((p:any)=>p.location).map((p:any)=>({id:p.id,lat:p.location.latitude,lng:p.location.longitude,name:p.displayName?.text||"Tourist place",category:"tourist",address:p.formattedAddress})),
                ...fuelStations.filter((p:any)=>p.location).map((p:any)=>({id:`fuel-${p.id}`,lat:p.location.latitude,lng:p.location.longitude,name:p.displayName?.text||(p.category === "ev_charging" ? "EV charging station" : "Fuel station"),category:p.category || "fuel",address:p.formattedAddress}))
              ]}
              onPlaceClick={(mp) => { const p = routeAttractions.find((x:any)=>x.id === mp.id); if (p) previewNearbyPlace(p); else { const station=fuelStations.find((x:any)=>`fuel-${x.id}`===mp.id); if(station) previewNearbyPlace(station); } }}
            />
            <div className="map-list-grid" style={{marginTop:18}}>
              <div>
                <h3>⭐ Tourist places along route</h3>
                {routeAttractionsLoading ? <p className="state-note loading">🔎 Finding tourist places along your route...</p> : routeAttractions.length ? routeAttractions.slice(0,20).map((p:any)=>{ const added=tripStops.some((x:any)=>String(x.id)===String(p.id)); return <div className="map-list-item route-place-card" key={p.id}><button type="button" onClick={()=>previewNearbyPlace(p)}><span><b>⭐ {p.displayName?.text}</b><small>{p.category || "Tourist attraction"} · {p.formattedAddress || ""}</small><small>{typeof p._routeDistanceKm === "number" ? `${p._routeDistanceKm.toFixed(1)} km from route` : "Along selected route"}</small></span><span>🧭</span></button><button type="button" className={added ? "trip-added" : "trip-add"} onClick={()=>toggleAddToTrip(p)}>{added ? "✓ Added" : "+ Add to Trip"}</button></div>; }) : <p className="state-note">No tourist attractions were found along this route.</p>}
              </div>
              <div>
                <h3>📍 {t("nearbyPlaces")}</h3>
                {nearby.length ? nearby.slice(0,20).map((p:any)=><button className="map-list-item" key={p.id} type="button" onClick={()=>previewNearbyPlace(p)}><span><b>{p.displayName?.text}</b><small>{p.formattedAddress || ""}</small></span><span>🧭</span></button>) : <p className="muted">{t("noNearby")}</p>}
              </div>
            </div>
          </section>
        )}

        {/* SEPARATE FILLING STATIONS SCREEN */}
        {view === "fuel" && (
          <section className="card places-screen standalone-screen">
            <div className="screen-nav">
              <button type="button" onClick={() => navigate("/destination")}>🧭 Route</button>
              <button type="button" onClick={() => navigate("/places")}>📍 Nearby & Tourist Places</button>
              <button type="button" className="primary" onClick={() => navigate("/fuel")}>⛽ Filling Stations</button>
              <button type="button" onClick={() => navigate("/planner")}>🧳 Trip Planner</button>
            </div>
            <h2>⛽ {t("fillingStations")}</h2>
            <p className="muted">Petrol/diesel bunks and EV charging points along your selected route, or from your current GPS location.</p>

            <div className="station-filter-tabs">
              <button type="button" className={stationFilter === "all" ? "active" : ""} onClick={() => setStationFilter("all")}>All</button>
              <button type="button" className={stationFilter === "fuel" ? "active" : ""} onClick={() => setStationFilter("fuel")}>⛽ Petrol / Diesel</button>
              <button type="button" className={stationFilter === "ev_charging" ? "active" : ""} onClick={() => setStationFilter("ev_charging")}>⚡ EV Charging</button>
            </div>

            {(() => {
              const visibleStations = fuelStations.filter((p: any) =>
                stationFilter === "all" ? true : (p.category || "fuel") === stationFilter
              );
              return (
                <>
                  <MapView
                    location={loc || source?.location}
                    currentLocation={loc}
                    destination={dest?.location ? {lat: dest.location.latitude, lng: dest.location.longitude} : undefined}
                    routes={showRouteResults ? routes : []}
                    selectedRoute={selectedRoute}
                    language={language}
                    places={visibleStations.filter((p:any)=>p.location).map((p:any)=>({id:`fuel-${p.id}`,lat:p.location.latitude,lng:p.location.longitude,name:p.displayName?.text||(p.category==="ev_charging"?"EV charging station":"Fuel station"),category:p.category||"fuel",address:p.formattedAddress}))}
                    onPlaceClick={(mp) => { const p = fuelStations.find((x:any)=>`fuel-${x.id}` === mp.id); if (p) previewNearbyPlace(p); }}
                  />
                  <div style={{marginTop:18, display:"grid", gap:8}}>
                    {fuelStationsLoading ? (
                      <p className="state-note loading">🔎 Finding petrol and EV charging stations along your route...</p>
                    ) : !routes[selectedRoute]?.geometry?.coordinates?.length ? (
                      <p className="state-note">Select a route first to see petrol and EV charging stations along it.</p>
                    ) : visibleStations.length ? (
                      visibleStations.slice().sort((a:any,b:any)=>(a._currentDistanceKm??a._routeDistanceKm??Infinity)-(b._currentDistanceKm??b._routeDistanceKm??Infinity)).map((p:any) => {
                        const isEv = p.category === "ev_charging";
                        return (
                          <button className="map-list-item station-card" key={p.id} type="button" onClick={()=>previewNearbyPlace(p)}>
                            <span>
                              <b>{isEv ? "⚡" : "⛽"} {p.displayName?.text}
                                <span className={`station-badge ${isEv ? "ev" : "fuel"}`}>{isEv ? "EV Charging" : "Petrol/Diesel"}</span>
                              </b>
                              <small>{p.formattedAddress || ""}{p.openingHours ? ` · ${p.openingHours}` : ""}</small>
                            </span>
                            <span>{typeof p._distanceAlongRouteKm === "number" ? `${p._distanceAlongRouteKm.toFixed(0)} km ahead` : typeof p._routeDistanceKm === "number" ? `${p._routeDistanceKm.toFixed(1)} km from route` : (isEv ? "⚡" : "⛽")}</span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="state-note">
                        {stationFilter === "ev_charging" ? "No EV charging stations were found along this route." : stationFilter === "fuel" ? "Fuel station data is temporarily unavailable." : t("noFuel")}
                      </p>
                    )}
                  </div>
                </>
              );
            })()}
          </section>
        )}

        {/* SAFETY MODAL */}
        {handshake && (

          <div className="modal">

            <div className="card">

              <h2>
                ⚠️ Are you OK?
              </h2>

              <p>
                Possible safety event detected.
                Respond within{" "}
                {countdown} seconds.
              </p>

              <button
                className="primary"
                onClick={cancelHandshake}
              >
                I'M SAFE
              </button>

              <button
                className="sos"
                onClick={escalateHandshake}
              >
                GET HELP
              </button>

            </div>

          </div>

        )}

        {/* SEPARATE JOURNEY SCREEN — source/destination/trip state remains unchanged */}
        {journeyMode && view === "journey" && (
          <div className="journey-screen">
            <div className="journey-topbar">
              <div><b>🚀 {t("journeyMode")}</b><span>{source?.displayName?.text || "Current location"} → {dest?.displayName?.text || "Destination"}</span></div>
              <button type="button" onClick={() => { setJourneyMode(false); navigate("/destination"); }}>{t("exitJourney")}</button>
            </div>
            <div className="journey-grid">
              <section className="card journey-directions-card">
                <h2>🗺️ {t("directions")}</h2>
                {routes[selectedRoute]?.steps?.length ? (() => {
                  const steps = routes[selectedRoute].steps;
                  const current = steps[Math.min(activeStep, steps.length - 1)];
                  const next = steps[Math.min(activeStep + 1, steps.length - 1)];
                  return (
                    <div className="navigation-instructions">
                      <div className="nav-main">
                        <div className="nav-arrow">↑</div>
                        <div>
                          <small>Towards</small>
                          <strong>{current?.instruction || "Continue on the road"}</strong>
                          {current?.distanceMeters ? <span>{(current.distanceMeters / 1000).toFixed(2)} km</span> : null}
                        </div>
                      </div>
                      <div className="nav-then">
                        <b>Then</b>
                        <span>↪</span>
                        <div><strong>{next?.instruction || current?.instruction || "Continue on the road"}</strong></div>
                      </div>
                    </div>
                  );
                })() : <p className="muted">{t("directionsUnavailable")}</p>}
                {routes[selectedRoute] && <div className="journey-summary"><b>{t("route")} {selectedRoute + 1}</b><span>{(Number(routes[selectedRoute].distanceMeters || 0)/1000).toFixed(1)} km</span><span>{routes[selectedRoute].safetyScore}/100 safety</span></div>}
              </section>
              <section className="card">
                <MapView
                  location={loc || source?.location}
                  currentLocation={loc}
                  destination={dest?.location ? {lat:dest.location.latitude,lng:dest.location.longitude} : undefined}
                  routes={showRouteResults ? routes : []}
                  showAlternatives={true}
                  selectedRoute={selectedRoute}
                  language={language}
                  places={[...nearby.filter((p:any)=>p.location).map((p:any)=>({id:p.id,lat:p.location.latitude,lng:p.location.longitude,name:p.displayName?.text||"Place",category:nearbyType,address:p.formattedAddress})), ...fuelStations.filter((p:any)=>p.location).map((p:any)=>({id:`fuel-${p.id}`,lat:p.location.latitude,lng:p.location.longitude,name:`⛽ ${p.displayName?.text||"Fuel station"}`,category:"fuel",address:p.formattedAddress}))]}
                />
                <div className="journey-actions">
                  <button type="button" onClick={sendSOS} className="sos">🚨 SOS</button>
                  <button type="button" onClick={() => speakCurrentScreen()}>🔊 {t("listen")}</button>
                  <button type="button" onClick={() => { setJourneyMode(false); navigate("/destination"); }}>{t("exitJourney")}</button>
                </div>
              </section>
            </div>
          </div>
        )}

      </main>

      {/* PERSISTENT SOS — always available, not just once a
          journey has started. sendSOS already works with or
          without an active journey (journeyId is optional). */}
      <button
        onClick={sendSOS}
        title="Send SOS with your live location"
        style={{
          position: "fixed",
          right: "20px",
          bottom: "24px",
          zIndex: 4000,
          background: "#dc2626",
          color: "#fff",
          border: "none",
          borderRadius: "999px",
          padding: "16px 22px",
          fontWeight: 800,
          fontSize: "15px",
          boxShadow: "0 6px 18px rgba(220,38,38,0.5)",
          cursor: "pointer"
        }}
      >
        🚨 SOS
      </button>

      {/* NEARBY PLACE PREVIEW — rendered above whichever screen is
          currently open (Home/Destination/Places/Fuel/Planner) so
          tapping a hospital/hotel/fuel/tourist result never navigates
          away from the current page. Only the explicit "Set as
          Destination" button below actually changes the trip. */}
      {previewPlace && (
        <div
          className="modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(4, 10, 24, 0.92)",
            zIndex: 3500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            overflowY: "auto"
          }}
        >
          <div className="card" style={{ width: "100%", maxWidth: "560px", maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2 style={{ margin: 0 }}>{previewPlace.displayName?.text || "Selected place"}</h2>
                <p className="muted" style={{ margin: "4px 0 0" }}>{previewPlace.formattedAddress || ""}</p>
              </div>
              <button onClick={closeNearbyPreview}>✕ Close</button>
            </div>

            <div style={{ marginTop: "14px" }}>
              <MapView
                location={getNearbyReference() || loc || undefined}
                currentLocation={loc}
                destination={{ lat: previewPlace.location.latitude, lng: previewPlace.location.longitude }}
                routes={previewRoute}
                selectedRoute={0}
                language={language}
              />
            </div>

            <p className="muted" style={{ marginTop: "8px" }}>
              {previewRouteLoading
                ? "Calculating route…"
                : previewRoute[0]
                  ? `🧭 ${(previewRoute[0].distanceMeters / 1000).toFixed(1)} km, ~${Math.round(Number.parseFloat(String(previewRoute[0].duration).replace("s", "")) / 60)} min by road`
                  : "Live route data unavailable"}
            </p>

            <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
              {previewPlace.nationalPhoneNumber && (
                <a href={`tel:${previewPlace.nationalPhoneNumber}`} style={{ color: "#22c55e", fontWeight: 700, textDecoration: "none" }}>
                  📞 {previewPlace.nationalPhoneNumber}
                </a>
              )}
              <button className="primary" type="button" onClick={confirmPreviewAsDestination}>
                📍 Set as Destination
              </button>
              <button type="button" onClick={closeNearbyPreview}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}