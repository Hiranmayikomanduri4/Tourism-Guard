# Setup checklist

## Google Cloud
Enable:
- Maps JavaScript API
- Places API (New)
- Routes API
- Roads API

Use a browser-restricted key for the client and a server-restricted key for backend web services. Routes and other web services require authentication; Google recommends API-key restrictions and billing setup.

## Environment
Server: see `server/.env.example`.
Client: see `client/.env.example`.

`AUTHORITY_INVITE_CODE` must be set if you want to create an authority account through the registration UI.

`TRUSTED_CONTACT_WEBHOOK_URL` is optional. It must point to a real notification service you control. If absent, the event still reaches the authority dashboard, but the system does not pretend a trusted-contact message was sent.

## Real GPS
Use HTTPS in deployment. The browser asks the user for location permission. Journey Mode controls when consented location updates are sent to the backend.
