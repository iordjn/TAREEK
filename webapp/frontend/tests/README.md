Run `npm ci` and `npm test` from `webapp/frontend` (Node 22.22.2+, 24.15+,
or 26+ as specified in `package.json`). jsdom is a development-only dependency; the app still
runs as plain browser JavaScript without a framework or build step.

These DOM tests exercise the actual HTML and application scripts against mocked
API responses based on every committed example. They verify lossless hydration
and export, individual edits, survey roles/files, county customization,
navigation/focus, invalid edits, failed requests and request ordering. Advanced
editor checks cover two-way synchronization, nested freight/MATSim settings,
arrays, nulls, booleans, protected fields, metadata validation, and review/export
gating. Backend tests also review/export every registered preset and compare
source-file bytes before and after. The DOM tests do
not start the FastAPI app, download county data, or require simulation inputs.
Responsive layout and the live Leaflet map should additionally be checked in a
browser when changing CSS or map behavior.
