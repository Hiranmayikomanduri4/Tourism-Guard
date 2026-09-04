# Manual Source → Destination Multi-Route Feature

Changes made:
- Added manual Source search/selection and Destination search/selection on the destination screen.
- Added a Find Available Routes + Risk Scores action.
- Routing uses OSRM alternatives and GeoJSON road geometry.
- Each route receives a Tourism Guardian safety score based on the existing weather/restricted-zone logic and a distance penalty for very long routes.
- Restricted-zone checks now use the actual OSRM route geometry instead of the empty encoded polyline field.
- Map routes are colored by score: green = safe, yellow = moderate, red = high risk.
- The selected route is the safest route returned by the backend.
- Live GPS remains available for the actual Journey Safety Mode; it is no longer forced as the planning source.
- Real live traffic is not claimed because the public OSRM endpoint used by this project does not provide live traffic data.

## Environment files

The real `.env` files were intentionally excluded from this modified ZIP. Copy your values into the existing `.env.example` files locally before running the project.
