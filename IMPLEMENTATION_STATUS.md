# Tourism Guardian - Complete Requested Update

Implemented in this package:
- Manual source selection or current GPS source.
- Destination search/selection.
- Route planning page after source+destination selection.
- Consent-based live GPS tracking for journey mode and fresh GPS for SOS.
- OSRM alternative road routes with per-route safety score.
- Selected-route-only map view while retaining all route score cards.
- Route geometry based off-route detection.
- Filling stations along the selected route during an active journey.
- Nearby hospitals, hotels, police and transport around either current location or destination.
- Destination tourist attractions with route/risk calculation when selected.
- Voice search for source, destination and general place search when browser speech recognition is available.
- English, Telugu, Hindi and Tamil language selector on core screens.
- SOS and automatic emergency escalation carry the selected language and translated emergency message to the authority dashboard.
- Authority dashboard displays emergency locations on a map.
- Transparent 30-minute predictive safety heuristic based on currently available weather/restricted-zone/route signals.

Safety transparency:
- Public OSRM is not treated as a live traffic source.
- No scam/pickpocket/harassment incident feed is fabricated. The UI/data model is ready for a verified incident provider later.
