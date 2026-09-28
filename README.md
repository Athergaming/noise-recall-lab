# Noise & Recall Lab (SDG 4 · Quality Education)

Does the sound level (dB) of background talking affect how well people recall a sequence of digits in order?

**Live site:** see the link in the repo description. Share it with anyone; everyone's results go into one shared database.

## How to use
1. **Run test** – enter your group name + participant code (no names), tick consent, do the headphone check, press Start.
2. **Calibrate & settings** – the physics student calibrates the talking sound with a dB meter (per device).
3. **Results** – everyone's data combined: hypothesis verdict, graphs (download as PNG), statistics, CSV export.
4. **How to** – full protocol, AirPods settings, calibration steps, and credits.

## Design (defaults)
- Conditions: Quiet + 40, 50, 60, 70, 80, 90 dB(A) of real recorded talking. Order counterbalanced with a Latin square.
- 15 digits (1–9) per sequence, shown 15 s, 30 s to type. 6 sequences per level → 42 per participant (~35 min).
- 1 point per digit in the right position → percent correct.

## How data is stored
Each trial is saved in the browser first, then uploaded to a Supabase Postgres database (`js/config.js` holds the
public URL + publishable key). The database lets anyone **read** results and **add** trials, but nobody can edit them.
Deleting a trial needs the admin passcode (ask the project owner). If the Wi-Fi drops, trials upload later automatically.

## Code map (for the CSP write-up)
| File | What it does |
|---|---|
| `js/sequences.js` | Seeded random sequences, Latin-square order, per-participant plan |
| `js/noise.js` | Loops the real recordings / generates white noise, converts dB targets into gain |
| `js/stats.js` | Scoring, mean/SD/SE, regression, ANOVA + p-values, verdict |
| `js/charts.js` | SVG charts with tooltips and PNG export |
| `js/storage.js` | Browser storage + CSV export/import |
| `js/cloud.js` | Upload/download to the shared database |
| `js/app.js` | Screens, test runner, results page |
| `tools/make_audio.py` | Rebuilds `js/audio-data.js` from the recordings (`tools/download_sources.sh` fetches them) |

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` and visit http://localhost:8000.

## Sound credits
- Talking: “Group discussion 1” and “Group discussion 3” by ezwa (PDSounds), Wikimedia Commons, public domain.
- Construction (optional): “Baustelle am Mödlingbach” by TofuVegan, Wikimedia Commons, CC BY-SA 4.0 — made mono, trimmed, looped, levelled.
