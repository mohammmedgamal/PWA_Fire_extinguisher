# Fire Extinguisher Survey (PWA)

A Progressive Web App that lets power plant operators check fire extinguishers by scanning a QR code on each one.
It works offline and installs to the phone's home screen. There is no server and no build step.

## What it does

- **Scan**: tap **Scan QR code** and point the camera at the extinguisher's label. A **Flashlight** button helps in dark areas, and the code can be typed in if the label is damaged.
- **See the extinguisher**:
  - its name, code, location, type and capacity
  - the date and time of the last check and who did it
  - the condition found at the last check (OK, or the list of problems)
  - a warning if more than 30 days have passed since the last check
  - the full history of past checks
- **Record the survey**: choose **OK** or **NOT OK**. For NOT OK, the operator ticks every problem that applies:
  corroded / rusted, damaged / dented, needs casing / cabinet, low pressure, safety pin or seal missing, hose or nozzle damaged,
  label unreadable, access blocked, needs refill, service overdue, bracket damaged, missing from location, or other (a note is required).
  Notes can be added, and the operator's name is remembered for next time.
- **Home screen**: lists every extinguisher with its last result, shows how many are **Not OK** and how many are **Due**, and has search and filters.
- **Adding extinguishers**: scanning a code the app doesn't know offers to register it, and the **+** button adds one by hand.
- **QR labels**: the app can make a printable label (QR code plus name, code and location). The label can be shared, downloaded or printed.
- **CSV export**: menu ⋮ → *Export surveys (CSV)*. The file opens in Excel (UTF-8 with BOM) or can be sent by email from the share sheet.
- **Backup / restore**: menu ⋮ → JSON backup. Restoring *merges* the backup into the device, so data from several phones can be combined.

## Data storage

All data is kept **on the device**, in the browser's IndexedDB storage. Each phone has its own data.
Use the CSV export for reports, and use the JSON backup/restore to move or combine data between devices.
Clearing the browser's site data deletes the records, so take backups regularly.

## Running and hosting

The camera only works over **HTTPS** (or `http://localhost`). Any static host will do,
for example GitHub Pages, Netlify or an internal IIS/nginx server. Upload the repository's files as they are.

Local test (needs Node 18 or newer, no `npm install` required):

```sh
npm start
# open http://localhost:8080
```

### Deploy on Railway

The repo includes a dependency-free Node server (`server.js`) and a `railway.json`, so Railway can deploy it as it is:

1. On [railway.com](https://railway.com), choose **New Project → Deploy from GitHub repo** and pick this repository
   (in the service's **Settings → Source**, choose the branch to deploy).
2. Railway detects Node and runs `node server.js`, which listens on the `PORT` Railway provides.
3. In the service's **Settings → Networking**, click **Generate Domain** to get a public `https://…up.railway.app` address.
   Railway provides HTTPS, so the camera works. A custom domain can be added in the same place.
4. Open that address on the operators' phones and install the app.

Each push to the deployed branch redeploys automatically.
Make the QR labels from the final address: each label holds a link to the site it was printed from.

To install, open the site on the phone, then choose *Install app* (Android/Chrome) or *Share → Add to Home Screen* (iOS/Safari).

### About the QR codes

Each label's QR code holds a link like `https://your-host/#/ext/FE-001`, so the phone's own camera app can open the extinguisher directly.
The in-app scanner also accepts QR codes that contain only the plain code (e.g. `FE-001`), so existing labels from other systems work too.
Codes are not case-sensitive and are stored in upper case.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app (plain HTML/CSS/JS, no framework) |
| `server.js`, `package.json`, `railway.json` | Small static web server and Railway settings for hosting |
| `sw.js` | Service worker that lets the app work offline |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (`node icons/render.mjs` regenerates the PNGs with Playwright) |
| `vendor/jsQR.js` | QR decoding (jsQR 1.4.0, Apache-2.0). Used when the browser has no native `BarcodeDetector` |
| `vendor/qrcode.js` | QR generation for labels (qrcode-generator 2.0.4, MIT) |

When changing app files, bump `CACHE` in `sw.js` so installed copies pick up the update.
