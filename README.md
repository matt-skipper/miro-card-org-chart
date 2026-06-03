# Miro Card Org Chart

A [Miro](https://miro.com) Web SDK app that builds an **organizational chart on the board** from a CSV file. It creates **cards** for each person, draws **elbow connectors** for reporting lines, and includes **conditional formatting** plus **single-card field editing** in the side panel.

See this Miro board for additional documentation: https://miro.com/app/board/uXjVHW0co2g=/?share_link_id=739600105069

---

## Features

- **CSV wizard (4 steps)** — Choose **vertical** or **horizontal** layout, upload a `.csv` file, map columns to hierarchy roles (employee name, employee ID, supervisor ID), then choose which extra columns become **card fields** (up to **20** fields per card). Optional **Include header values** prefixes values as `ColumnName: value` on the card.
- **Vertical and horizontal layouts** — Positions are computed with a **Buchheim** tree layout (linear time, suitable for large orgs). Vertical charts grow top-to-bottom. Horizontal charts grow left-to-right, stack siblings vertically, and draw connectors from manager **right** edge to child **left** edge. If layout throws, the app **falls back** to a simple grid in the selected orientation.
- **Leaf-column mode for vertical charts** — Managers whose **entire direct team are individual contributors** (2+ reports, no grandchildren) get a **vertical stack** of ICs to the right, with connectors from manager **bottom** to IC **left** edge; other vertical links use manager **bottom** to child **top**. Horizontal charts do not use the leaf-column post-process because siblings already stack vertically.
- **Import hardening** — CSV uploads are validated before import: `.csv` files only, max **5 MB**, max **100** columns, max **1,000** data rows, and max **1,000** cards per import.
- **Conditional formatting** — Select cards on the board → **Load selected cards** → pick field, text or numeric condition, value → **card theme** swatch (preset palette, **custom colors** via gradient picker and optional **eyedropper** where the browser supports it) → optional **fill background** → **Apply to matching cards**.
- **Single card details** — Select one card → **Load selected card** → view fields; **Edit fields** / **Save changes** updates the card on the board (preserves “header:” style prefixes when present).
- **Production hosting support** — The production build can be served by `server.js` for Elastic Beanstalk or any Node host. Security headers are applied in the Node server, Vite dev/preview server, and `public/_headers` for compatible static hosts.
- **Mirotone UI** — Panel and modal use [Mirotone](https://www.mirotone.xyz/) for a native Miro look.

---

## Tech stack

| Piece | Role |
| ----- | ---- |
| [Vite](https://vitejs.dev/) | Dev server, multi-page build (`index.html`, `app.html`, `create-chart.html`) |
| [Miro Web SDK v2](https://developers.miro.com/docs/web-sdk-reference) | Board UI, cards, connectors, selection, modals |
| [Mirotone](https://www.mirotone.xyz/) | CSS design system for the panel and upload modal |
| Node `http` server | Serves the production `dist/` build with security headers |

Layout is implemented in `src/app.js` (Buchheim + vertical leaf-column post-process + horizontal axis swap); there is **no** ELK/elkjs dependency.

---

## Prerequisites

- **Node.js** (LTS recommended) and npm  
- A **Miro developer account** and an app registered in the [Miro Developer Portal](https://developers.miro.com/)  
- For local development, use a **Chromium-based browser** over HTTP. Safari often blocks or restricts `localhost` HTTP.

---

## Getting started

### 1. Install

```bash
git clone <your-repo-url>
cd miro-card-org-chart
npm install
```

### 2. Run locally

```bash
npm run dev
```

The Vite dev server listens on **http://localhost:3009** (see `vite.config.js`) and serves the same security headers used by production.

### 3. Connect the app in Miro

1. In the [Miro Developer Portal](https://developers.miro.com/), set **App URL** to your local app root, e.g. `http://localhost:3009/` (or whatever URL your team uses for the `index.html` entry).
2. Enable scopes so the app can read/write the board (e.g. **board:read** and **board:write** as required by your manifest).
3. Open the app on a board. Click the **app icon** — the side panel loads **`app.html`** (`src/index.js` registers the icon handler).

### 4. Build for production

```bash
npm run build
```

Static output is written to **`dist/`**. Host `dist/` on any static host, or serve it with `npm start`, and point the Miro app **App URL** at that deployment.

Preview the build locally:

```bash
npm start
```

`npm start` serves `dist/` with the production Node static server on **http://localhost:8080** by default, or the `PORT` value provided by the host. The server only serves exact built files and adds security headers including CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.

### 5. Deploy to Elastic Beanstalk

Elastic Beanstalk runs `npm start` for the web process. This project builds the static Vite app during deployment via `.platform/hooks/predeploy/01-build.sh`, then `server.js` serves exact files from `dist/` on `${PORT:-8080}`.

The EB start path is:

```bash
npm run build
npm start
```

---

## CSV and column mapping

The file must be a `.csv`, be **5 MB or smaller**, and include a **header row**. A single import supports up to **100 columns**, **1,000 data rows**, and **1,000 cards**. You are not limited to fixed column names: the **Map columns** step binds your CSV headers to three roles:

| Role in UI | Purpose |
| ---------- | ------- |
| **Employee Name** | Becomes the **card title** (rows with an empty name are skipped). |
| **Employee ID** | **Stable identifier** for each person (commonly work email). Matching is case-insensitive after trim. |
| **Supervisor ID** | Must match another row’s **Employee ID** for that person to report under them. If empty or unknown, the person is treated as a **root** (top of a tree). |

The **Additional information** step lists every CSV column **except** the three mapped hierarchy columns. Checked columns (up to **20**) become **card fields**; tooltips on fields use the original header text.

A sample file lives at [`public/Miro_OrgChart_Template.csv`](./public/Miro_OrgChart_Template.csv). The upload modal links to it as **Download CSV template**.

---

## Usage

### Side panel (`app.html`)

1. **Create new org chart** — Opens a modal (`create-chart.html`): choose vertical or horizontal layout → upload CSV → map hierarchy columns → choose extra fields → **Done** creates cards and connectors near the **current viewport**, then zooms to the first created card.
2. **Conditional formatting** — Expand the section → select target cards on the board → **Load selected cards** → set field / condition / value / color → **Apply to matching cards**.
3. **Single card details** — Expand the section → select **one** card → **Load selected card** → **Edit fields** if needed → **Save changes**.

---

## Project structure

```
.
├── index.html            # Local landing; loads Miro SDK + src/index.js (icon → panel)
├── app.html              # Side panel: org chart trigger, formatting, single-card editor
├── create-chart.html     # Modal: 4-step layout + CSV upload flow (same JS bundle as panel)
├── public/
│   ├── Miro_OrgChart_Template.csv
│   └── _headers          # Security headers for compatible static hosts
├── src/
│   ├── index.js          # init(): icon:click → openPanel({ url: 'app.html' })
│   ├── app.js            # CSV → tree → Buchheim layout → cards/connectors; all panel/modal UI
│   └── assets/
│       └── style.css     # Mirotone import + app/modal layout
├── vite.config.js        # All *.html at repo root as Rollup inputs; dev server port 3009
├── server.js             # Production static server for dist/ with security headers
└── package.json
```

`src/app.js` is shared: each HTML page only contains the DOM for its flow; setup functions **no-op** when their elements are missing (`init()` at the bottom of `app.js`).

---

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Vite dev server (`localhost:3009` by default) |
| `npm run build` | Production build → `dist/` |
| `npm start` | Serve the production `dist/` folder on `${PORT:-8080}` with security headers |
| `npm run serve` | Preview production build with Vite (`vite preview`) |

---

## License

MIT — see [`package.json`](./package.json).

---

## References

- [Miro Web SDK](https://developers.miro.com/docs/web-sdk-reference)  
- [Miro app manifest & hosting](https://developers.miro.com/docs/app-manifest)  
- [Mirotone](https://www.mirotone.xyz/)  
- Buchheim et al., *Improving Walker’s Algorithm to Run in Linear Time* (JGAA, 2002) — basis for the tree layout in `src/app.js`
