# Miro Card Org Chart

A [Miro](https://miro.com) Web SDK app that builds an **organizational chart on the board** from a CSV file. It creates **cards** for each person, draws **elbow connectors** for reporting lines, and includes **conditional formatting** plus **single-card field editing** in the side panel.

See this Miro board for additional documentation: https://miro.com/app/board/uXjVHW0co2g=/?share_link_id=739600105069

---

## Features

- **CSV wizard (4 steps with a labeled stepper)** — Choose **vertical** or **horizontal** layout → upload a `.csv` file → map columns → choose card fields. The wizard shows a **Layout → Upload → Map → Fields** stepper with done/active states, and **Create org chart** runs the import with a live **progress bar** ("N of M cards", then "N of M connectors").
- **Upload with instant feedback** — The dropzone accepts drag & drop, click, or keyboard (Enter/Space). Files are parsed on selection and shown as a **file chip** with size, row count, and column count, plus a **remove (✕)** to clear. Constraints (.csv · 5 MB · 1,000 rows) are shown inline. Optional **Include header values** prefixes values as `ColumnName: value` on the card.
- **Column auto-match** — The Map step **auto-matches** hierarchy columns from your headers (e.g. `Name`, `Work Email`, `Manager Email Address`) with an "auto" badge per match. Matching is conservative: a role is only auto-filled when exactly one column qualifies, and a manual change clears the badge.
- **Pre-import validation** — Once all three columns are mapped, the wizard shows a **data preview** (first rows of the mapped columns) and a **dry-run summary**: employees, top-level leads, **unmatched supervisors**, **manager cycles**, and rows **skipped** for empty names — before anything touches the board.
- **Field selection with search** — The Fields step has a **search filter**, a live **"X of 20 selected"** counter, and an **import summary** (layout · file · card count · fields per card). Up to **20** fields per card.
- **Vertical and horizontal layouts** — Positions are computed with a **Buchheim** tree layout (linear time, suitable for large orgs). Vertical charts grow top-to-bottom. Horizontal charts grow left-to-right, stack siblings vertically, and draw connectors from manager **right** edge to child **left** edge. If layout throws, the app **falls back** to a simple grid in the selected orientation.
- **Leaf-column mode for vertical charts** — Managers whose **entire direct team are individual contributors** (2+ reports, no grandchildren) get a **vertical stack** of ICs to the right, with connectors from manager **bottom** to IC **left** edge; other vertical links use manager **bottom** to child **top**. Horizontal charts do not use the leaf-column post-process because siblings already stack vertically.
- **Import hardening** — CSV uploads are validated before import: `.csv` files only, max **5 MB**, max **100** columns, max **1,000** data rows, and max **1,000** cards per import.
- **Live selection** — The panel tracks the board selection via the SDK **`selection:update`** event. Selecting cards on the board updates the panel automatically — there are no "Load" buttons.
- **Conditional formatting with preview** — Select cards on the board → build a rule (field, text or numeric condition, value) → pick a **card theme** swatch (preset palette, **custom colors** via gradient picker and optional **eyedropper** where the browser supports it) → optional **fill background**. A **preview card** and a live **"X of Y cards match"** meter show the effect before you commit; the button applies to exactly the matching cards ("Apply to 3 cards").
- **Single card details** — Select one card → identity block (initials avatar, title, field count) with fields rendered as a **read-only definition list**. **Edit** switches to inputs; **Cancel** reverts without saving; **Save changes** syncs to the board (preserves "Header:" style prefixes when present).
- **Inline feedback** — Success and error messages render **inside the panel next to the action** (apply counts, save confirmations, validation errors) and auto-dismiss. Board notifications are reserved for board-context events (chart created).
- **Keyboard & screen-reader support** — The dropzone is focusable and keyboard-operable, the color swatch grid is a single tab stop with **arrow-key** navigation, and selection counts / match counts announce via **`aria-live`** regions.
- **About page** — The app root (`index.html`) is an "About this app" landing page with feature overview, CSV requirements, and the template download.
- **Production hosting support** — The production build can be served by `server.js` for Elastic Beanstalk or any Node host. Security headers are applied in the Node server, Vite dev/preview server, and `public/_headers` for compatible static hosts.
- **Mirotone UI** — Panel and modal build on [Mirotone](https://www.mirotone.xyz/) for a native Miro look.

---

## Tech stack

| Piece | Role |
| ----- | ---- |
| [Vite](https://vitejs.dev/) | Dev server, multi-page build (`index.html`, `app.html`, `create-chart.html`) |
| [Miro Web SDK v2](https://developers.miro.com/docs/web-sdk-reference) | Board UI, cards, connectors, selection events, modals |
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

The file must be a `.csv`, be **5 MB or smaller**, and include a **header row**. A single import supports up to **100 columns**, **1,000 data rows**, and **1,000 cards**. You are not limited to fixed column names: the **Map** step binds your CSV headers to three roles (and **auto-matches** them when your headers make the mapping unambiguous):

| Role in UI | Purpose |
| ---------- | ------- |
| **Employee Name** | Becomes the **card title** (rows with an empty name are skipped and reported in the validation summary). |
| **Employee ID** | **Stable identifier** for each person (commonly work email). Matching is case-insensitive after trim. |
| **Supervisor ID** | Must match another row's **Employee ID** for that person to report under them. If empty or unknown, the person is treated as a **root** (top of a tree) — unknown supervisors are flagged in the validation summary before import. |

The **Fields** step lists every CSV column **except** the three mapped hierarchy columns. Checked columns (up to **20**) become **card fields**; tooltips on fields use the original header text.

A sample file lives at [`public/Miro_OrgChart_Template.csv`](./public/Miro_OrgChart_Template.csv). It is downloadable from the panel home, the upload step, and the landing page as **Download CSV template**.

---

## Usage

### Side panel (`app.html`)

The panel opens on a **home view** with the primary action and two tools. A live pill shows how many cards are currently selected on the board.

1. **Create org chart** — Opens the wizard modal (`create-chart.html`): choose layout → upload CSV → review auto-matched columns and the validation summary → choose card fields → **Create org chart**. A progress bar tracks cards and connectors; when done the modal closes and the viewport zooms to the chart.
2. **Conditional formatting** — Select target cards on the board (the view updates live) → build the rule and pick a style → check the preview and the **"X of Y cards match"** meter → **Apply to N cards**.
3. **Card details** — Select exactly **one** card (the view updates live) → review fields → **Edit** → change values → **Save changes** (or **Cancel** to revert).

---

## Project structure

```
.
├── index.html            # "About this app" landing page; loads Miro SDK + src/index.js (icon → panel)
├── app.html              # Side panel: home (hero + tool cards), conditional formatting, card details
├── create-chart.html     # Modal: 4-step wizard (stepper, upload chip, auto-match, validation, progress)
├── public/
│   ├── Miro_OrgChart_Template.csv
│   └── _headers          # Security headers for compatible static hosts
├── src/
│   ├── index.js          # init(): icon:click → openPanel({ url: 'app.html' })
│   ├── app.js            # CSV → tree → Buchheim layout → cards/connectors; selection store; all panel/modal UI
│   └── assets/
│       └── style.css     # Mirotone import + app tokens + panel/wizard components
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
- Buchheim et al., *Improving Walker's Algorithm to Run in Linear Time* (JGAA, 2002) — basis for the tree layout in `src/app.js`
