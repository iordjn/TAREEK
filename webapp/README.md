# Simulation Config Wizard

A web-based step-by-step wizard for building MATSim simulation configuration files.

## Prerequisites

- Python 3.9+ with the project's `.venv` activated
- Required packages: `fastapi`, `uvicorn`, `geopandas`, `requests`

## Setup

1. **Install dependencies** (from project root):

   ```bash
   .venv/Scripts/pip install fastapi "uvicorn[standard]"
   ```

   (`geopandas` and `requests` should already be installed in the project venv.)

2. **Ensure county shapefile exists** at `data/counties/cb_2022_us_county_500k.shp`.
   If missing, the server will auto-download it on first startup from the Census Bureau.

## Running

From the `webapp/` directory:

```bash
cd webapp
../.venv/Scripts/python run.py
```

The server starts at **http://localhost:8000**.

## First Startup

On first launch, the backend will:
1. Convert the county shapefile to simplified GeoJSON (~30s)
2. Fetch county population data from the Census API (~10s)

These are cached to `data/counties/counties.geojson` and `data/counties/county_population.json` so subsequent starts are instant.

## Structure

```
webapp/
  backend/
    main.py              # FastAPI server, API endpoints, config assembly
    requirements.txt     # Backend dependencies
  frontend/
    index.html           # Main wizard page
    css/style.css        # Design system (single stylesheet)
    js/app.js            # Wizard logic, map, form state, export
    js/config-state.js   # Shared configuration, snapshots and field paths
    js/advanced-editor.js # Recursive editor, metadata and safe review differences
  run.py                 # Entry point (uvicorn launcher)
```

## Wizard Panels

1. **Choose a Starting Configuration** — Regional experiment cards from the preset API,
   including survey variants, or Custom Configuration from `config/config_local.json`.
2. **Region** — Customize included counties on an interactive map.
3. **Surveys** — Review survey weights and regional input paths on the execution host.
4. **Transportation Modes** — Enable/disable car, bus, rail, walk, bike with per-mode settings.
5. **Transit** — GTFS feed settings and pt2matsim mapping parameters.
6. **Travel Demand** — Scaling factor, activity chains, non-work trip purposes.
7. **Time & Duration** — Activity duration constraints, time model settings.
8. **Simulation** — MATSim iterations, capacity factors, traffic counts, evaluation settings.
9. **Advanced Configuration** — Recursively edit nested objects, arrays, typed
   values and nulls. Dotted MATSim names remain literal keys. Descriptions come
   from config help annotations; known field metadata provides choices and limits.
10. **Review & Export** — Compare user edits with the normalized starting config,
    see load/export migrations separately, validate, and review portability notes
    before downloading the complete `config.json`.

The selected experiment's complete configuration stays in memory. Controls update
only their corresponding fields; freight, advanced MATSim settings, survey roles,
and other unexposed parameters survive export. Changing the starting configuration
replaces current settings after confirmation if there are edits. Compatibility
notes are available beneath the cards; review paths/resources on the execution host.

The advanced editor and wizard subscribe to the same state. Arrays have explicit
add/remove controls, nullable fields have a type selector, and unknown JSON fields
remain in the configuration. Credential keys, authenticated URLs, runtime fields,
and metadata are hidden from editing and redacted from review values. Containers
with protected descendants cannot be replaced wholesale. Invalid input drafts
are retained and block export without overwriting the last valid field value.

Review uses `/api/config/prepare` for structural validation, then exports through
`/api/export`. Validation results apply only to the exact configuration reviewed;
any further edit requires validation again. Input-file availability and machine
readiness remain separate execution-host checks.

The final step validates and exports `config.json` for `run_experiment.py`; the
wizard does not execute simulations. Source examples and the maintained baseline
are never written by the frontend. See [frontend tests](frontend/tests/README.md)
for DOM regression checks; Node is needed only for tests, not to serve the app.
