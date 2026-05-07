# Miro Card Org Chart

A [Miro](https://miro.com) Web SDK app that builds an **organizational chart on the board** from a CSV file. It creates **cards** for each person, draws **elbow connectors** for reporting lines, and includes **conditional formatting** plus **single-card field editing** in the side panel.

---

## Features

- **CSV wizard (3 steps)** — Upload a `.csv` file, map columns to hierarchy roles (employee name, employee ID, supervisor ID), then choose which extra columns become **card fields** (up to **20** fields per card). Optional **Include header values** prefixes values as `ColumnName: value` on the card.
- **Layout** — Positions are computed with a **Buchheim** tree layout (linear time, suitable for large orgs). If layout throws, the app **falls back** to a simple level-by-level grid. **Leaf-column** mode: managers whose **entire direct team are individual contributors** (2+ reports, no grandchildren) get a **vertical stack** of ICs to the right, with connectors from manager **bottom** to IC **left** edge; other links use manager **bottom** to child **top**.
- **Conditional formatting** — Select cards on the board → **Load selected cards** → pick field, text or numeric condition, value → **card theme** swatch (preset palette, **custom colors** via gradient picker and optional **eyedropper** where the browser supports it) → optional **fill background** → **Apply to matching cards**.
- **Single card details** — Select one card → **Load selected card** → view fields; **Edit fields** / **Save changes** updates the card on the board (preserves “header:” style prefixes when present).
- **Mirotone UI** — Panel and modal use [Mirotone](https://www.mirotone.xyz/) for a native Miro look.

---

## Tech stack

| Piece | Role |
| ----- | ---- |
| [Vite](https://vitejs.dev/) | Dev server, multi-page build (`index.html`, `app.html`, `create-chart.html`) |
| [Miro Web SDK v2](https://developers.miro.com/docs/web-sdk-reference) | Board UI, cards, connectors, selection, modals |
| [Mirotone](https://www.mirotone.xyz/) | CSS design system for the panel and upload modal |

Layout is implemented in `src/app.js` (Buchheim + leaf-column post-process); there is **no** ELK/elkjs dependency.

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
npm start
```

The Vite dev server listens on **http://localhost:3009** (see `vite.config.js`).

### 3. Connect the app in Miro

1. In the [Miro Developer Portal](https://developers.miro.com/), set **App URL** to your local app root, e.g. `http://localhost:3009/` (or whatever URL your team uses for the `index.html` entry).
2. Enable scopes so the app can read/write the board (e.g. **board:read** and **board:write** as required by your manifest).
3. Open the app on a board. Click the **app icon** — the side panel loads **`app.html`** (`src/index.js` registers the icon handler).

### 4. Build for production

```bash
npm run build
```

Static output is written to **`dist/`**. Host `dist/` on any static host and point the Miro app **App URL** at that deployment.

Preview the build locally:

```bash
npm run serve
```

(`vite preview` defaults to port **4173** unless overridden.)

---

## CSV and column mapping

The file must include a **header row**. You are not limited to fixed column names: the **Map columns** step binds your CSV headers to three roles:

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

1. **Create new org chart** — Opens a modal (`create-chart.html`): upload CSV → map hierarchy columns → choose extra fields → **Done** creates cards and connectors near the **current viewport**, then zooms to the first created card.
2. **Conditional formatting** — Expand the section → select target cards on the board → **Load selected cards** → set field / condition / value / color → **Apply to matching cards**.
3. **Single card details** — Expand the section → select **one** card → **Load selected card** → **Edit fields** if needed → **Save changes**.

---

## Project structure

```
.
├── index.html            # Local landing; loads Miro SDK + src/index.js (icon → panel)
├── app.html              # Side panel: org chart trigger, formatting, single-card editor
├── create-chart.html     # Modal: 3-step CSV upload (same JS bundle as panel)
├── public/
│   └── Miro_OrgChart_Template.csv
├── src/
│   ├── index.js          # init(): icon:click → openPanel({ url: 'app.html' })
│   ├── app.js            # CSV → tree → Buchheim layout → cards/connectors; all panel/modal UI
│   └── assets/
│       └── style.css     # Mirotone import + app/modal layout
├── vite.config.js        # All *.html at repo root as Rollup inputs; dev server port 3009
└── package.json
```

`src/app.js` is shared: each HTML page only contains the DOM for its flow; setup functions **no-op** when their elements are missing (`init()` at the bottom of `app.js`).

---

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm start` | Vite dev server (`localhost:3009` by default) |
| `npm run build` | Production build → `dist/` |
| `npm run serve` | Preview production build (`vite preview`) |

---

## License

MIT — see [`package.json`](./package.json).

---

## References

- [Miro Web SDK](https://developers.miro.com/docs/web-sdk-reference)  
- [Miro app manifest & hosting](https://developers.miro.com/docs/app-manifest)  
- [Mirotone](https://www.mirotone.xyz/)  
- Buchheim et al., *Improving Walker’s Algorithm to Run in Linear Time* (JGAA, 2002) — basis for the tree layout in `src/app.js`
