/**
 * Miro Card Org Chart — Miro Web SDK app (v2)
 *
 * This module is loaded by both `app.html` (side panel) and `create-chart.html` (upload modal).
 * Each `setup*` function exits early if its DOM nodes are absent so one bundle serves both pages.
 *
 * Layout: Buchheim tree (Walker-style, O(n) via thread/ancestor shortcuts).
 *   - Synchronous — usable for hundreds of cards without a Web Worker
 *   - Parent centered over children; no overlaps; compact horizontal spacing
 *   - Leaf-column pass: managers whose direct reports are all leaves (2+) get a vertical IC stack
 *
 * Card fields: chosen in the modal’s step 3 (`fieldCols`); empty cells omitted; tooltips = CSV headers.
 *
 * Reference: "Improving Walker's Algorithm to Run in Linear Time"
 *            Buchheim, Jünger, Leipert — JGAA 2002
 */
import './assets/style.css';

// ─── Constants ────────────────────────────────────────────────────────────────

const CARD_WIDTH = 320;
const CARD_HEIGHT = 94;
/** Edge-to-edge horizontal gap between sibling cards */
const H_GAP = 48;
/** Edge-to-edge vertical gap between a parent's bottom and its children's tops */
const V_GAP = 108;
/** Center-to-center horizontal distance between adjacent siblings */
const NODE_DISTANCE = CARD_WIDTH + H_GAP;
/** Center-to-center vertical distance between depth levels */
const LEVEL_HEIGHT = CARD_HEIGHT + V_GAP;
const DEFAULT_CARD_THEME = '#5f94e0';
const MAX_CSV_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 1000;
const MAX_CSV_COLUMNS = 100;
const MAX_CARDS_PER_IMPORT = 1000;

// ─── Leaf Column Constants ────────────────────────────────────────────────────
// Applied when a manager's entire direct team are leaves (no grandchildren).
// Instead of spreading children below, they are stacked vertically to the right.

/** Horizontal distance from manager center to IC stack center */
const LEAF_COL_X_OFFSET = Math.round(CARD_WIDTH / 2 + 44);
/**
 * Vertical gaps used by the leaf column layout. These are edge-to-edge gaps
 * (independent of card height) so the visual breathing room stays constant
 * even when cards grow taller due to extra fields.
 */
/** Edge-to-edge gap from manager bottom to first IC card top */
const LEAF_COL_GAP_BELOW_MANAGER = 156;
/** Edge-to-edge gap between stacked IC cards */
const LEAF_COL_GAP_BETWEEN_ICS = 120;
/**
 * Extended Buchheim node distance used when the LEFT sibling is a leaf-col manager.
 * Reserves horizontal space for the IC stack that extends to the right of that manager.
 * = NODE_DISTANCE + LEAF_COL_X_OFFSET (ensures H_GAP clearance after the stack's right edge).
 */
const LEAF_COL_NODE_DISTANCE = NODE_DISTANCE + LEAF_COL_X_OFFSET;

// ─── Horizontal Layout Constants ──────────────────────────────────────────────
// Horizontal layout: tree grows left→right instead of top→bottom. Siblings stack
// vertically; depth levels spread horizontally. Leaf-col is disabled in this
// mode because regular Buchheim already arranges siblings in a vertical column.

/** Horizontal layout: edge-to-edge vertical gap between sibling cards */
const H_LAYOUT_SIBLING_GAP = 64;
/** Horizontal layout: edge-to-edge horizontal gap between a parent's right and its children's lefts */
const H_LAYOUT_LEVEL_GAP = 108;

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

/** Split CSV text into { headers, rows }. Handles quoted fields and \r\n. */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) rows.push(parseCSVLine(lines[i]));
  return { headers, rows };
}

/** Parse one CSV line; commas inside double-quoted fields are not delimiters. */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += c; }
  }
  result.push(current.trim());
  return result;
}

function validateCsvFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return 'Only CSV files are supported.';
  }
  if (file.size > MAX_CSV_FILE_SIZE_BYTES) {
    return `CSV files must be ${Math.round(MAX_CSV_FILE_SIZE_BYTES / 1024 / 1024)} MB or smaller.`;
  }
  return '';
}

function validateCsvData({ headers, rows }) {
  if (!headers.length) return 'The CSV file appears to be empty.';
  if (headers.length > MAX_CSV_COLUMNS) {
    return `CSV files can include up to ${MAX_CSV_COLUMNS} columns.`;
  }
  if (rows.length > MAX_CSV_ROWS) {
    return `CSV files can include up to ${MAX_CSV_ROWS} data rows.`;
  }
  return '';
}

async function readValidatedCsvFile(file) {
  const fileError = validateCsvFile(file);
  if (fileError) throw new Error(fileError);
  const text = await file.text();
  const parsed = parseCSV(text);
  const dataError = validateCsvData(parsed);
  if (dataError) throw new Error(dataError);
  return parsed;
}

/** Human-readable file size for the upload chip. */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Conservative header auto-matcher for the mapping step.
 * Only matches a role when exactly one candidate column qualifies —
 * a wrong auto-match is worse than none.
 * Returns { name, email, manager } with header strings or null.
 */
function autoMatchColumns(headers) {
  const norm = (h) => (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries = headers.map((h) => ({ h, n: norm(h) }));
  const isMgr = (n) => /(manager|supervisor|reportsto|mgr)/.test(n);
  const pickUnique = (cands) => (cands.length === 1 ? cands[0].h : null);

  const result = { name: null, email: null, manager: null };
  result.manager = pickUnique(entries.filter((e) => isMgr(e.n)));

  let rest = entries.filter((e) => e.h !== result.manager);
  result.email =
    pickUnique(rest.filter((e) => !isMgr(e.n) && /(email|employeeid|workerid|personid|userid)/.test(e.n))) ||
    pickUnique(rest.filter((e) => !isMgr(e.n) && e.n === 'id'));

  rest = rest.filter((e) => e.h !== result.email);
  result.name =
    pickUnique(rest.filter((e) => ['name', 'fullname', 'employeename', 'employee'].includes(e.n))) ||
    pickUnique(rest.filter((e) => !isMgr(e.n) && /name/.test(e.n)));

  return result;
}

function setSelectOptions(select, values, placeholderText = '') {
  const options = [];
  if (placeholderText) options.push(new Option(placeholderText, ''));
  values.forEach((value) => options.push(new Option(value, value)));
  select.replaceChildren(...options);
}

/** Convert raw string rows into objects keyed by header name. */
function rowsToRecords(headers, rows) {
  return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])));
}

/** Normalize employee/supervisor IDs for hierarchy matching (trim + lowercase). */
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

// ─── Org Tree ─────────────────────────────────────────────────────────────────

/**
 * Build the org hierarchy from flat records.
 * Uses dynamic column mapping: { nameCol, emailCol, managerEmailCol }.
 * People whose manager ID is absent or unknown become roots.
 * Cycles / unreachable nodes are attached as extra roots so BFS still covers every valid row.
 */
function buildOrgTree(records, { nameCol, emailCol, managerEmailCol }) {
  const emailToIndex = new Map();
  const validIndices = [];
  for (let i = 0; i < records.length; i++) {
    const name = (records[i][nameCol] || '').trim();
    if (!name) continue;
    validIndices.push(i);
    const email = normalizeEmail(records[i][emailCol]);
    if (email) emailToIndex.set(email, i);
  }
  const managerToEmployees = new Map();
  const roots = [];
  for (const i of validIndices) {
    const mgEmail = normalizeEmail(records[i][managerEmailCol]);
    const mgIndex = mgEmail ? emailToIndex.get(mgEmail) : null;
    if (mgIndex != null && mgIndex !== i) {
      if (!managerToEmployees.has(mgIndex)) managerToEmployees.set(mgIndex, []);
      managerToEmployees.get(mgIndex).push(i);
    } else {
      roots.push(i);
    }
  }
  // BFS levels — used only for the fallback grid layout
  const levels = [];
  let current = roots.slice();
  const added = new Set(current);
  while (current.length) {
    levels.push(current.slice());
    const next = [];
    for (const i of current)
      for (const j of managerToEmployees.get(i) || [])
        if (!added.has(j)) { added.add(j); next.push(j); }
    current = next;
  }
  const missing = validIndices.filter((i) => !added.has(i));
  if (missing.length) {
    levels.length ? (levels[0] = [...missing, ...levels[0]]) : levels.push(missing);
    missing.forEach((i) => added.add(i));
  }
  const indexToLevelAndOrder = new Map();
  for (let lev = 0; lev < levels.length; lev++) {
    const row = levels[lev];
    for (let k = 0; k < row.length; k++)
      indexToLevelAndOrder.set(row[k], { level: lev, order: k, rowSize: row.length });
  }
  return { validIndices, levels, indexToLevelAndOrder, managerToEmployees, emailToIndex, roots };
}

/**
 * Dry-run analysis of the org hierarchy for the pre-import validation banner.
 * Mirrors buildOrgTree's matching rules without touching the board:
 *   - employees: rows with a non-empty name
 *   - roots: people with no/unknown/self supervisor (top-level leads)
 *   - unmatched: rows whose supervisor ID matches no Employee ID (silently become roots on import)
 *   - cycles: people unreachable from any root (manager cycles)
 *   - skipped: rows with an empty name (not imported)
 */
function analyzeOrgRecords(records, { nameCol, emailCol, managerEmailCol }) {
  const emailToIndex = new Map();
  const valid = [];
  let skipped = 0;
  records.forEach((rec, i) => {
    const name = (rec[nameCol] || '').trim();
    if (!name) { skipped += 1; return; }
    valid.push(i);
    const email = normalizeEmail(rec[emailCol]);
    if (email) emailToIndex.set(email, i);
  });

  const children = new Map();
  const rootIdx = [];
  let unmatched = 0;
  for (const i of valid) {
    const mg = normalizeEmail(records[i][managerEmailCol]);
    const mi = mg ? emailToIndex.get(mg) : undefined;
    if (!mg || mi == null || mi === i) {
      rootIdx.push(i);
      if (mg && mi == null) unmatched += 1;
    } else {
      if (!children.has(mi)) children.set(mi, []);
      children.get(mi).push(i);
    }
  }

  // BFS from roots; anyone unreachable is in a manager cycle
  const reached = new Set(rootIdx);
  const queue = [...rootIdx];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of children.get(cur) || []) {
      if (!reached.has(child)) { reached.add(child); queue.push(child); }
    }
  }
  const cycles = valid.filter((i) => !reached.has(i)).length;

  return { employees: valid.length, roots: rootIdx.length, unmatched, cycles, skipped };
}

// ─── Buchheim Layout ──────────────────────────────────────────────────────────
//
// The Buchheim algorithm is the gold standard for aesthetically pleasing tree
// layout. It generalizes Reingold-Tilford to run in O(n) time by replacing the
// O(n²) contour-merging step with an ancestor pointer trick (the `ancestor` and
// `thread` fields below). Key aesthetic properties:
//
//   1. No two nodes overlap.
//   2. Each parent is horizontally centered over its children.
//   3. Identical subtrees receive identical layouts (symmetry).
//   4. Trees are as compact as possible subject to the above.

class LayoutNode {
  constructor(index) {
    this.index = index;   // record index; -1 = virtual root (not drawn)
    this.depth = 0;       // BFS depth from structural roots
    this.children = [];
    this.parent = null;
    this.number = 0;      // 1-based position among siblings (required by algorithm)
    // Buchheim state
    this.prelim = 0;      // preliminary x (center of subtree)
    this.mod = 0;         // accumulated shift applied to all descendants
    this.shift = 0;       // shift queued by moveSubtree
    this.change = 0;      // slope of shift distribution across siblings
    this.thread = null;   // shortcut pointer across subtrees for contour traversal
    this.ancestor = this; // pointer used by apportion()
  }
  get isLeaf() { return this.children.length === 0; }
  get leftChild() { return this.children[0] || null; }
  get rightChild() { return this.children[this.children.length - 1] || null; }
  leftSibling() {
    return (this.parent && this.number > 1) ? this.parent.children[this.number - 2] : null;
  }
  /** Next node on this subtree's left contour (thread shortcut if leaf). */
  nextLeft() { return this.isLeaf ? this.thread : this.leftChild; }
  /** Next node on this subtree's right contour (thread shortcut if leaf). */
  nextRight() { return this.isLeaf ? this.thread : this.rightChild; }
}

/**
 * Identify managers whose entire direct team are leaves (no grandchildren) AND
 * who have 2+ direct reports. These get a vertical IC stack instead of Buchheim children.
 * Requiring 2+ reports avoids the leaf-column treatment for single-IC managers.
 */
function getLeafColManagers(tree) {
  const leaves = new Set(tree.validIndices.filter((i) => !tree.managerToEmployees.has(i)));
  const leafColMgrs = new Set();
  for (const [mgr, emps] of tree.managerToEmployees) {
    if (emps.length >= 2 && emps.every((e) => leaves.has(e))) leafColMgrs.add(mgr);
  }
  return leafColMgrs;
}

/**
 * Convert the org tree into LayoutNodes and assign depths via BFS.
 * Multiple roots are wrapped in a virtual root (index -1) so the
 * Buchheim pass treats the whole org as a single tree.
 *
 * Leaf-col managers' IC children are EXCLUDED from the layout tree so
 * those managers appear as leaves in Buchheim. Their ICs are positioned
 * separately by applyLeafColLayout after the main pass.
 */
function buildLayoutTree(tree, leafColMgrs) {
  const nodeMap = new Map();
  for (const i of tree.validIndices) nodeMap.set(i, new LayoutNode(i));

  for (const [mgr, emps] of tree.managerToEmployees) {
    if (leafColMgrs.has(mgr)) continue; // ICs handled by leaf-col post-process
    const mgrNode = nodeMap.get(mgr);
    if (!mgrNode) continue;
    for (const emp of emps) {
      const empNode = nodeMap.get(emp);
      if (!empNode) continue;
      empNode.parent = mgrNode;
      mgrNode.children.push(empNode);
    }
  }
  // 1-based sibling numbering (required by moveSubtree denominator)
  for (const node of nodeMap.values())
    node.children.forEach((c, i) => (c.number = i + 1));

  // BFS from structural roots to assign depths
  const roots = tree.roots.map((i) => nodeMap.get(i)).filter(Boolean);
  const reached = new Set(roots);
  const q = [...roots];
  while (q.length) {
    const n = q.shift();
    for (const c of n.children) {
      if (!reached.has(c)) { c.depth = n.depth + 1; reached.add(c); q.push(c); }
    }
  }

  // Nodes unreachable from roots (cycles, bad data): isolate and treat as extra roots
  const unreached = tree.validIndices
    .map((i) => nodeMap.get(i))
    .filter((n) => n && !reached.has(n));
  unreached.forEach((n) => { n.parent = null; n.children = []; n.depth = 0; });

  const allRoots = [...roots, ...unreached];
  let root;
  if (allRoots.length === 1) {
    root = allRoots[0];
  } else {
    // Virtual root at depth -1; its children are the real roots at depth 0
    root = new LayoutNode(-1);
    root.depth = -1;
    allRoots.forEach((r, i) => { r.parent = root; r.number = i + 1; root.children.push(r); });
  }
  return { root, nodeMap };
}

/**
 * First pass: compute preliminary x coordinates bottom-up.
 * `nodeDistance` is the standard center-to-center sibling distance along the spread axis.
 * `leafColNodeDistance` is used when the left sibling is a leaf-col manager, reserving
 * room for its IC stack (equal to `nodeDistance` when leaf-col is disabled).
 */
function buchFirstWalk(v, leafColMgrs, nodeDistance, leafColNodeDistance) {
  if (v.isLeaf) {
    const w = v.leftSibling();
    const dist = (w && leafColMgrs.has(w.index)) ? leafColNodeDistance : nodeDistance;
    v.prelim = w ? w.prelim + dist : 0;
  } else {
    let defaultAncestor = v.children[0];
    for (const w of v.children) {
      buchFirstWalk(w, leafColMgrs, nodeDistance, leafColNodeDistance);
      defaultAncestor = buchApportion(w, defaultAncestor, leafColMgrs, nodeDistance, leafColNodeDistance);
    }
    buchExecuteShifts(v);
    const mid = (v.leftChild.prelim + v.rightChild.prelim) / 2;
    const leftSib = v.leftSibling();
    if (leftSib) {
      const dist = leafColMgrs.has(leftSib.index) ? leafColNodeDistance : nodeDistance;
      v.prelim = leftSib.prelim + dist;
      v.mod = v.prelim - mid; // shift so descendants are centered under v
    } else {
      v.prelim = mid;
    }
  }
}

/**
 * Merge the contours of v's subtree with its left sibling's subtree.
 * Shifts v's subtree right by the minimum amount needed to avoid overlap.
 * Uses ancestor pointers to achieve O(n) overall complexity.
 * `leafColNodeDistance` is applied when the contour traversal lands on a leaf-col manager.
 */
function buchApportion(v, defaultAncestor, leafColMgrs, nodeDistance, leafColNodeDistance) {
  const w = v.leftSibling();
  if (!w) return defaultAncestor;

  // vir/vor: inside/outside right contour of v's subtree
  // vil/vol: inside/outside left contour of w's subtree
  let vir = v, vor = v, vil = w, vol = v.parent.children[0];
  let sir = vir.mod, sor = vor.mod, sil = vil.mod, sol = vol.mod;

  while (vil.nextRight() && vir.nextLeft()) {
    vil = vil.nextRight(); vir = vir.nextLeft();
    vol = vol.nextLeft();  vor = vor.nextRight();
    vor.ancestor = v;
    const dist = leafColMgrs.has(vil.index) ? leafColNodeDistance : nodeDistance;
    const shift = (vil.prelim + sil) - (vir.prelim + sir) + dist;
    if (shift > 0) {
      buchMoveSubtree(buchGetAncestor(vil, v, defaultAncestor), v, shift);
      sir += shift; sor += shift;
    }
    sil += vil.mod; sir += vir.mod; sol += vol.mod; sor += vor.mod;
  }
  // Extend contours via thread pointers so future apportions don't re-traverse
  if (vil.nextRight() && !vor.nextRight()) {
    vor.thread = vil.nextRight();
    vor.mod += sil - sor;
  }
  if (vir.nextLeft() && !vol.nextLeft()) {
    vol.thread = vir.nextLeft();
    vol.mod += sir - sol;
    defaultAncestor = v;
  }
  return defaultAncestor;
}

/** Distribute a required shift evenly across the siblings between wl and wr. */
function buchMoveSubtree(wl, wr, shift) {
  const subtrees = wr.number - wl.number;
  wr.change -= shift / subtrees; wr.shift += shift;
  wl.change += shift / subtrees;
  wr.prelim += shift; wr.mod += shift;
}

/** Apply queued shifts right-to-left so each sibling accumulates its share. */
function buchExecuteShifts(v) {
  let shift = 0, change = 0;
  for (let i = v.children.length - 1; i >= 0; i--) {
    const w = v.children[i];
    w.prelim += shift; w.mod += shift;
    change += w.change; shift += w.shift + change;
  }
}

/** Return vil's ancestor if it is a sibling of v; otherwise use defaultAncestor. */
function buchGetAncestor(vil, v, defaultAncestor) {
  return (vil.ancestor.parent === v.parent) ? vil.ancestor : defaultAncestor;
}

/**
 * Second pass: convert preliminary positions + accumulated mod offsets into final coords.
 *
 * In 'vertical' layout (the original), `prelim` is the x coordinate and `depth × levelHeight`
 * is the y coordinate — tree grows top→bottom.
 * In 'horizontal' layout, the axes swap: `prelim` becomes y and `depth × levelHeight` becomes
 * x — tree grows left→right.
 */
function buchSecondWalk(v, m, positionByIndex, levelHeight, layout) {
  if (v.index !== -1) {
    const along = v.prelim + m;
    const depth = v.depth * levelHeight;
    positionByIndex.set(v.index, layout === 'horizontal'
      ? { x: depth, y: along }
      : { x: along, y: depth });
  }
  for (const w of v.children) buchSecondWalk(w, m + v.mod, positionByIndex, levelHeight, layout);
}

/**
 * Run the full Buchheim layout.
 * Returns { positionByIndex, leafColMgrs } where positionByIndex is
 * Map<recordIndex, {x, y}> in layout coordinates (centered around the origin on
 * the spread axis).
 *
 * In 'vertical' layout, leaf-col managers' IC children are NOT yet positioned —
 * call applyLeafColLayout next. In 'horizontal' layout, leaf-col is disabled
 * (regular Buchheim already stacks siblings vertically), so leafColMgrs is empty.
 *
 * @param {object} tree
 * @param {number} [cardHeight=CARD_HEIGHT] — actual card height (from probe card measurement)
 * @param {'vertical'|'horizontal'} [layout='vertical']
 */
function computeBuchheimLayout(tree, cardHeight = CARD_HEIGHT, layout = 'vertical') {
  let nodeDistance, leafColNodeDistance, levelHeight, leafColMgrs;
  if (layout === 'horizontal') {
    // Siblings stack along the vertical (spread) axis; levels advance horizontally.
    nodeDistance = cardHeight + H_LAYOUT_SIBLING_GAP;
    leafColNodeDistance = nodeDistance; // leaf-col disabled in horizontal mode
    levelHeight = CARD_WIDTH + H_LAYOUT_LEVEL_GAP;
    leafColMgrs = new Set();
  } else {
    nodeDistance = NODE_DISTANCE;
    leafColNodeDistance = LEAF_COL_NODE_DISTANCE;
    levelHeight = cardHeight + V_GAP;
    leafColMgrs = getLeafColManagers(tree);
  }
  const { root } = buildLayoutTree(tree, leafColMgrs);
  buchFirstWalk(root, leafColMgrs, nodeDistance, leafColNodeDistance);
  const positionByIndex = new Map();
  buchSecondWalk(root, -root.prelim, positionByIndex, levelHeight, layout);
  return { positionByIndex, leafColMgrs };
}

/**
 * Post-process: position each leaf-col IC in a vertical stack to the right of its manager.
 *   x = manager.x + LEAF_COL_X_OFFSET  (center of IC stack)
 *   y = manager.y + (cardHeight/2 + LEAF_COL_GAP_BELOW_MANAGER + cardHeight/2)
 *       + i * (cardHeight + LEAF_COL_GAP_BETWEEN_ICS)
 * Gap constants are edge-to-edge so visual spacing stays constant regardless of card height.
 * @param {number} [cardHeight=CARD_HEIGHT] — actual card height (from probe card measurement)
 */
function applyLeafColLayout(tree, positionByIndex, leafColMgrs, cardHeight = CARD_HEIGHT) {
  // Distance from manager center to first IC center (edge-to-edge gap between them)
  const leafColFirstY = cardHeight / 2 + LEAF_COL_GAP_BELOW_MANAGER + cardHeight / 2;
  // Center-to-center pitch between stacked IC cards
  const leafColVPitch = cardHeight + LEAF_COL_GAP_BETWEEN_ICS;
  for (const mgr of leafColMgrs) {
    const mgrPos = positionByIndex.get(mgr);
    if (!mgrPos) continue;
    const emps = tree.managerToEmployees.get(mgr) || [];
    emps.forEach((emp, i) => {
      positionByIndex.set(emp, {
        x: mgrPos.x + LEAF_COL_X_OFFSET,
        y: mgrPos.y + leafColFirstY + i * leafColVPitch,
      });
    });
  }
}

// ─── Card Fields ──────────────────────────────────────────────────────────────

/**
 * Build Miro card fields from the user-selected fieldCols (page 3 of the upload flow).
 * Skips empty cells. Tooltip is always the exact column header string.
 * When includeHeaders is true, the value is prefixed with the header: "Department: Sales".
 */
function getCardFieldsFromCsv(rec, includeHeaders, fieldCols) {
  const fields = [];
  for (const h of fieldCols) {
    const value = (rec[h] || '').trim();
    if (!value) continue;
    fields.push({ value: includeHeaders ? `${h}: ${value}` : value, tooltip: h });
  }
  return fields;
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

/**
 * Parse CSV, build tree, run Buchheim (+ leaf column), create cards and elbow connectors.
 * Uses a temporary “probe” card to measure real card height (extra fields grow the widget)
 * before final positions are computed so vertical gaps stay visually consistent.
 */
async function createCardsFromCSV(
  file,
  { nameCol, emailCol, managerEmailCol, fieldCols, layout = 'vertical' },
  onProgress = () => {},
) {
  const isHorizontal = layout === 'horizontal';
  const { headers, rows } = await readValidatedCsvFile(file);

  const records = rowsToRecords(headers, rows);
  const mapping = { nameCol, emailCol, managerEmailCol };
  const tree = buildOrgTree(records, mapping);
  if (tree.validIndices.length > MAX_CARDS_PER_IMPORT) {
    throw new Error(`A single import can create up to ${MAX_CARDS_PER_IMPORT} cards.`);
  }

  const totalCards = tree.validIndices.length;
  let totalConnectors = 0;
  for (const emps of tree.managerToEmployees.values()) totalConnectors += emps.length;
  onProgress({ phase: 'cards', done: 0, total: totalCards });

  const includeHeaders = document.getElementById('include-header-values')?.checked ?? false;

  const viewport = await miro.board.viewport.get();
  const startX = viewport.x + CARD_WIDTH / 2 + 100;
  const startY = viewport.y + CARD_HEIGHT / 2 + 100;

  // ── Probe card: create one card to measure actual rendered height ──────────
  // Card height grows with each additional field row (~30px each). We need the
  // real height before computing layout so vertical spacing stays consistent.
  const firstIndex = tree.validIndices[0];
  const firstRec = records[firstIndex];
  const firstName = (firstRec[nameCol] || '').trim();
  const firstFields = getCardFieldsFromCsv(firstRec, includeHeaders, fieldCols);
  const probeCard = await miro.board.createCard({
    title: firstName,
    fields: firstFields.length ? firstFields : undefined,
    x: startX,
    y: startY,
    style: { cardTheme: DEFAULT_CARD_THEME },
  });
  const cardHeight = probeCard.height || CARD_HEIGHT;

  // ── Buchheim layout — synchronous, instant at any size ────────────────────
  let positionByIndex;
  let leafColMgrs = new Set();
  try {
    ({ positionByIndex, leafColMgrs } = computeBuchheimLayout(tree, cardHeight, layout));
    if (!isHorizontal) applyLeafColLayout(tree, positionByIndex, leafColMgrs, cardHeight);
  } catch (err) {
    console.warn('Buchheim layout failed, falling back to grid:', err);
    positionByIndex = new Map();
    if (isHorizontal) {
      const colWidth  = CARD_WIDTH  + H_LAYOUT_LEVEL_GAP;
      const rowHeight = cardHeight  + H_LAYOUT_SIBLING_GAP;
      for (const i of tree.validIndices) {
        const { level, order, rowSize } = tree.indexToLevelAndOrder.get(i);
        positionByIndex.set(i, {
          x: level * colWidth,
          y: (order - (rowSize - 1) / 2) * rowHeight,
        });
      }
    } else {
      const levelHeight = cardHeight + V_GAP;
      for (const i of tree.validIndices) {
        const { level, order, rowSize } = tree.indexToLevelAndOrder.get(i);
        positionByIndex.set(i, {
          x: (order - (rowSize - 1) / 2) * NODE_DISTANCE,
          y: level * levelHeight,
        });
      }
    }
  }

  // ── Create cards (probe card repositioned; rest created fresh) ─────────────
  const indexToCard = new Map();
  const { x: px0, y: py0 } = positionByIndex.get(firstIndex) || { x: 0, y: 0 };
  probeCard.x = startX + px0;
  probeCard.y = startY + py0;
  await probeCard.sync();
  indexToCard.set(firstIndex, probeCard);
  let cardsDone = 1;
  onProgress({ phase: 'cards', done: cardsDone, total: totalCards });

  for (const i of tree.validIndices) {
    if (i === firstIndex) continue;
    const rec = records[i];
    const name = (rec[nameCol] || '').trim();
    const { x: px, y: py } = positionByIndex.get(i) || { x: 0, y: 0 };
    const fields = getCardFieldsFromCsv(rec, includeHeaders, fieldCols);
    const card = await miro.board.createCard({
      title: name,
      fields: fields.length ? fields : undefined,
      x: startX + px,
      y: startY + py,
      style: { cardTheme: DEFAULT_CARD_THEME },
    });
    indexToCard.set(i, card);
    cardsDone += 1;
    onProgress({ phase: 'cards', done: cardsDone, total: totalCards });
  }

  let connectorsDone = 0;
  onProgress({ phase: 'connectors', done: 0, total: totalConnectors });

  // Create connectors.
  // Horizontal layout: manager right-center → child left-center.
  // Vertical leaf-col edges: manager bottom-center → IC left-center.
  // Vertical regular edges: manager bottom-center → child top-center.
  for (const [mgr, emps] of tree.managerToEmployees) {
    const mgrCard = indexToCard.get(mgr);
    if (!mgrCard) continue;
    const isLeafCol = leafColMgrs.has(mgr);
    for (const emp of emps) {
      const empCard = indexToCard.get(emp);
      if (!empCard) continue;
      let startPos, endPos;
      if (isHorizontal) {
        startPos = { x: 1,   y: 0.5 };
        endPos   = { x: 0,   y: 0.5 };
      } else if (isLeafCol) {
        startPos = { x: 0.5, y: 1   };
        endPos   = { x: 0,   y: 0.5 };
      } else {
        startPos = { x: 0.5, y: 1   };
        endPos   = { x: 0.5, y: 0   };
      }
      await miro.board.createConnector({
        shape: 'elbowed',
        start: { item: mgrCard.id, position: startPos },
        end:   { item: empCard.id, position: endPos   },
        style: { strokeColor: '#3d3d3d', strokeWidth: 1, endStrokeCap: 'arrow' },
      });
      connectorsDone += 1;
      onProgress({ phase: 'connectors', done: connectorsDone, total: totalConnectors });
    }
  }

  const firstCard = indexToCard.get(tree.validIndices[0]);
  if (firstCard) await miro.board.viewport.zoomTo(firstCard);
  await miro.board.notifications.showInfo(
    `Created ${tree.validIndices.length} cards on the board`,
  );
}

// ─── Selection Store (panel) ──────────────────────────────────────────────────
// Single source of truth for the cards currently selected on the board.
// setupSelectionWatcher seeds it from getSelection() and keeps it fresh via the
// SDK 'selection:update' event, so panel views update live — no Load buttons.

const selectionStore = {
  cards: [],
  listeners: new Set(),
  set(cards) {
    this.cards = cards;
    this.listeners.forEach((fn) => {
      try { fn(cards); } catch (err) { console.error(err); }
    });
  },
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.cards);
  },
};

async function setupSelectionWatcher() {
  if (!document.getElementById('view-home')) return; // panel only
  const refresh = (items) => selectionStore.set((items || []).filter((i) => i.type === 'card'));
  try {
    refresh(await miro.board.getSelection());
  } catch (err) {
    console.warn('Could not read initial selection:', err);
  }
  try {
    miro.board.ui.on('selection:update', (event) => refresh(event.items));
  } catch (err) {
    console.warn('selection:update subscription failed:', err);
  }
}

// ─── Panel Navigation (home ↔ tool views) ────────────────────────────────────

function setupPanelNav() {
  const views = {
    home: document.getElementById('view-home'),
    formatting: document.getElementById('view-formatting'),
    details: document.getElementById('view-details'),
  };
  if (!views.home) return;

  const show = (name) => {
    Object.entries(views).forEach(([key, el]) => {
      if (el) el.style.display = key === name ? 'flex' : 'none';
    });
  };

  document.getElementById('nav-formatting')?.addEventListener('click', () => show('formatting'));
  document.getElementById('nav-details')?.addEventListener('click', () => show('details'));
  document.querySelectorAll('[data-nav-home]').forEach((btn) => {
    btn.addEventListener('click', () => show('home'));
  });

  // Live "N cards selected on board" pill on home
  const pill = document.getElementById('selection-pill');
  if (pill) {
    selectionStore.subscribe((cards) => {
      if (cards.length) {
        pill.textContent = `${cards.length} card${cards.length === 1 ? '' : 's'} selected on board`;
        pill.classList.add('is-visible');
      } else {
        pill.classList.remove('is-visible');
      }
    });
  }
}

// ─── Inline Feedback Messages (panel) ────────────────────────────────────────
// Success/error feedback rendered next to the triggering action instead of a
// board toast on the far side of the screen. Auto-dismisses; one message per
// slot so rapid actions replace rather than stack.

function showInlineMessage(slot, type, text) {
  if (!slot) return;
  slot.replaceChildren();
  const msg = document.createElement('div');
  msg.className = `inline-msg inline-msg-${type}`;
  msg.textContent = text;
  slot.append(msg);
  clearTimeout(slot._dismissTimer);
  slot._dismissTimer = setTimeout(() => {
    if (slot.contains(msg)) msg.remove();
  }, 4500);
}

// ─── Create Chart Button (panel) ─────────────────────────────────────────────
// Opens create-chart.html in a focused modal (app.html only).

const FEEDBACK_EMAIL = 'cardorgchart-app@miro.com';
const FEEDBACK_MAILTO =
  `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('Miro Card Org Chart Feedback')}`;

/** Open the default mail client without navigating the panel iframe. */
async function openFeedbackEmail() {
  try {
    const link = document.createElement('a');
    link.href = FEEDBACK_MAILTO;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  } catch (_) { /* fall through to clipboard fallback */ }

  try {
    await navigator.clipboard.writeText(FEEDBACK_EMAIL);
    await miro.board.notifications.showInfo(`Email address copied: ${FEEDBACK_EMAIL}`);
  } catch (_) {
    await miro.board.notifications.showInfo(`Send feedback to ${FEEDBACK_EMAIL}`);
  }
}

function setupFeedbackButton() {
  const btn = document.getElementById('panel-feedback-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openFeedbackEmail();
  });
}

function setupCreateChartButton() {
  const btn = document.getElementById('open-create-modal-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await miro.board.ui.openModal({
      url: 'create-chart.html',
      width: 480,
      height: 680,
      fullscreen: false,
    });
  });
}

// ─── Tooltip Esc Dismissal (WCAG 1.4.13) ─────────────────────────────────────
// Content shown on hover/focus must be dismissible without moving focus.
// Esc adds .tip-hidden (CSS suppresses the tooltip); leaving/blurring the
// anchor clears it so the tooltip works again on the next hover/focus.

function setupTooltipDismissal() {
  const anchors = document.querySelectorAll('.tooltip-anchor');
  if (!anchors.length) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    anchors.forEach((a) => a.classList.add('tip-hidden'));
  });
  anchors.forEach((anchor) => {
    ['mouseleave', 'blur'].forEach((evt) => {
      anchor.addEventListener(evt, () => anchor.classList.remove('tip-hidden'));
    });
  });
}

function setupModalInitialFocus() {
  if (!document.body.classList.contains('upload-modal')) return;
  // Pull focus into our iframe so the modal's X button loses its auto-focus highlight.
  document.body.tabIndex = -1;
  document.body.focus({ preventScroll: true });
  document.body.removeAttribute('tabindex');
}

// ─── File Upload Wizard (modal) ──────────────────────────────────────────────
// create-chart.html only. Four steps with a labeled stepper:
//   1 Layout → 2 Upload (parse on select, file chip) → 3 Map (auto-match +
//   preview + validation) → 4 Fields (search, counter, summary) → progress → done.

function setupFileUpload() {
  // Stepper
  const stepEls  = Array.from(document.querySelectorAll('.wizard-step'));
  const stepBars = Array.from(document.querySelectorAll('.wizard-step-bar'));
  // Step 1 (layout choice)
  const viewLayout      = document.getElementById('view-layout');
  const layoutOptions   = document.querySelectorAll('.layout-option');
  const layoutNextBtn   = document.getElementById('layout-next-btn');
  // Step 2 (upload)
  const input           = document.getElementById('file-upload');
  const dropZone        = document.getElementById('drop-zone');
  const dropErrorEl     = document.getElementById('drop-error');
  const fileChip        = document.getElementById('file-chip');
  const fileNameEl      = document.getElementById('file-name');
  const fileMetaEl      = document.getElementById('file-meta');
  const fileRemoveBtn   = document.getElementById('file-remove-btn');
  const nextBtn         = document.getElementById('next-btn');
  const uploadBackBtn   = document.getElementById('upload-back-btn');
  const viewUpload      = document.getElementById('view-upload');
  // Step 3 (mapping)
  const viewMapping     = document.getElementById('view-mapping');
  const nameSelect      = document.getElementById('map-name-col');
  const emailSelect     = document.getElementById('map-email-col');
  const managerSelect   = document.getElementById('map-manager-email-col');
  const autoBadges      = {
    name:    document.getElementById('auto-badge-name'),
    email:   document.getElementById('auto-badge-email'),
    manager: document.getElementById('auto-badge-manager'),
  };
  const automatchBanner = document.getElementById('automatch-banner');
  const previewWrap     = document.getElementById('mapping-preview-wrap');
  const previewEl       = document.getElementById('mapping-preview');
  const validationEl    = document.getElementById('validation-banner');
  const backBtn         = document.getElementById('back-btn');
  const mappingNextBtn  = document.getElementById('mapping-next-btn');
  // Step 4 (fields)
  const viewFields      = document.getElementById('view-fields');
  const fieldsListEl    = document.getElementById('fields-list');
  const fieldsSearchEl  = document.getElementById('fields-search');
  const fieldsCounterEl = document.getElementById('fields-counter');
  const selectAllEl     = document.getElementById('select-all-fields');
  const importSummaryEl = document.getElementById('import-summary');
  const fieldsBackBtn   = document.getElementById('fields-back-btn');
  const doneBtn         = document.getElementById('done-btn');
  // Progress overlay
  const loadingEl       = document.getElementById('view-loading');
  const progressBar     = document.getElementById('progress-bar');
  const progressCount   = document.getElementById('progress-count');
  const progressPhase   = document.getElementById('progress-phase');
  if (!input || !nextBtn) return;

  const MAX_FIELDS   = 20;
  let selectedFile   = null;
  let parsedCsv      = null;   // { headers, rows } — cached at selection time
  let selectedLayout = null;   // 'vertical' | 'horizontal'
  let lastAnalysis   = null;   // result of analyzeOrgRecords from the mapping step

  // ── Wizard view switching + stepper state ─────────────────────────────────
  const wizardViews = [viewLayout, viewUpload, viewMapping, viewFields];

  function showWizardView(activeView) {
    wizardViews.forEach((view) => {
      if (view) view.classList.toggle('is-active', view === activeView);
    });
    const activeIdx = wizardViews.indexOf(activeView); // -1 hides all (progress)
    stepEls.forEach((el, i) => {
      const isActive = i === activeIdx;
      const isDone = activeIdx > i || activeIdx === -1;
      el.classList.toggle('is-active', isActive);
      el.classList.toggle('is-done', isDone);
      // State for screen readers — visual state is color/checkmark only (WCAG 1.4.1/4.1.2)
      if (isActive) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
      const stateEl = el.querySelector('[data-step-state]');
      if (stateEl) stateEl.textContent = isDone ? ', completed' : (isActive ? ', current step' : '');
    });
    stepBars.forEach((bar, i) => {
      bar.classList.toggle('is-done', activeIdx > i || activeIdx === -1);
    });
  }

  showWizardView(viewLayout || viewUpload);

  // ── Step 1: layout choice ─────────────────────────────────────────────────
  // ARIA radio pattern: one tab stop, arrow keys move + select (mirrors the
  // color swatch grid implementation).

  function syncLayoutTabstops() {
    const opts = Array.from(layoutOptions);
    const selectedIdx = opts.findIndex((o) => o.getAttribute('aria-checked') === 'true');
    opts.forEach((o, i) => {
      o.tabIndex = (selectedIdx === -1 ? i === 0 : i === selectedIdx) ? 0 : -1;
    });
  }

  layoutOptions.forEach((opt) => {
    opt.addEventListener('click', () => {
      selectedLayout = opt.dataset.layout;
      layoutOptions.forEach((o) => o.setAttribute('aria-checked', String(o === opt)));
      syncLayoutTabstops();
      if (layoutNextBtn) layoutNextBtn.disabled = false;
    });
  });
  syncLayoutTabstops();

  const layoutGroup = document.querySelector('.layout-options');
  if (layoutGroup) {
    layoutGroup.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const opts = Array.from(layoutOptions);
      const idx = opts.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const next = opts[(idx + delta + opts.length) % opts.length];
      next.focus();
      next.click(); // radio pattern: selection follows focus
    });
  }

  if (layoutNextBtn) {
    layoutNextBtn.addEventListener('click', () => {
      if (!selectedLayout) return;
      showWizardView(viewUpload);
    });
  }

  if (uploadBackBtn) {
    uploadBackBtn.addEventListener('click', () => showWizardView(viewLayout));
  }

  // ── Step 2: drop zone + file chip ─────────────────────────────────────────

  function showDropError(msg) {
    if (dropErrorEl) { dropErrorEl.textContent = msg; dropErrorEl.style.display = 'block'; }
    if (dropZone) dropZone.classList.add('drop-zone--error');
  }

  function clearDropError() {
    if (dropErrorEl) dropErrorEl.style.display = 'none';
    if (dropZone) dropZone.classList.remove('drop-zone--error');
  }

  async function selectFile(file) {
    const fileError = validateCsvFile(file);
    if (fileError) {
      clearFile();
      showDropError(fileError);
      return;
    }
    let parsed;
    try {
      parsed = await readValidatedCsvFile(file);
    } catch (err) {
      clearFile();
      showDropError(err.message || String(err));
      return;
    }
    selectedFile = file;
    parsedCsv = parsed;
    clearDropError();
    if (fileNameEl) fileNameEl.textContent = file.name;
    if (fileMetaEl) {
      fileMetaEl.textContent =
        `${formatFileSize(file.size)} · ${parsed.rows.length} rows · ${parsed.headers.length} columns`;
    }
    if (fileChip) fileChip.style.display = 'flex';
    nextBtn.disabled = false;
  }

  function clearFile() {
    selectedFile = null;
    parsedCsv = null;
    lastAnalysis = null;
    input.value = '';
    nextBtn.disabled = true;
    if (fileChip) fileChip.style.display = 'none';
    if (fileNameEl) fileNameEl.textContent = '';
    if (fileMetaEl) fileMetaEl.textContent = '';
  }

  if (fileRemoveBtn) {
    fileRemoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearFile();
      clearDropError();
    });
  }

  // Dropzone: click anywhere or press Enter/Space to browse (keyboard accessible)
  if (dropZone) {
    dropZone.addEventListener('click', () => input.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
  }

  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) selectFile(file);
  });

  if (dropZone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
    });
    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, () => dropZone.classList.add('drop-zone--active'));
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, () => dropZone.classList.remove('drop-zone--active'));
    });
    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      selectFile(file);
    });
  }

  // ── Step 2 → Step 3: populate selects + auto-match ────────────────────────
  nextBtn.addEventListener('click', () => {
    if (!selectedFile || !parsedCsv) return;
    const { headers } = parsedCsv;
    [nameSelect, emailSelect, managerSelect].forEach((sel) => {
      if (sel) setSelectOptions(sel, headers, '— select column —');
    });

    const matched = autoMatchColumns(headers);
    const assignments = [
      [nameSelect, matched.name, 'name'],
      [emailSelect, matched.email, 'email'],
      [managerSelect, matched.manager, 'manager'],
    ];
    let matchCount = 0;
    assignments.forEach(([sel, value, key]) => {
      const badge = autoBadges[key];
      if (sel && value) {
        sel.value = value;
        matchCount += 1;
        if (badge) badge.style.visibility = 'visible';
      } else if (badge) {
        badge.style.visibility = 'hidden';
      }
    });

    if (automatchBanner) {
      if (matchCount > 0) {
        automatchBanner.textContent =
          `✨ We auto-matched ${matchCount} column${matchCount === 1 ? '' : 's'} from your headers — review and adjust if needed.`;
        automatchBanner.style.display = 'flex';
      } else {
        automatchBanner.style.display = 'none';
      }
    }

    checkMappingComplete();
    updateMappingExtras();
    showWizardView(viewMapping);
  });

  if (backBtn) backBtn.addEventListener('click', () => showWizardView(viewUpload));

  function checkMappingComplete() {
    const allSelected = [nameSelect, emailSelect, managerSelect].every((sel) => sel && sel.value);
    if (mappingNextBtn) mappingNextBtn.disabled = !allSelected;
  }

  // ── Step 3: data preview + dry-run validation ─────────────────────────────

  function renderMappingPreview(records, mapping) {
    if (!previewEl || !previewWrap) return;
    const cols = [mapping.nameCol, mapping.emailCol, mapping.managerEmailCol];
    const makeRow = (values, isHeader) => {
      const row = document.createElement('div');
      row.className = `mapping-preview-row${isHeader ? ' is-header' : ''}`;
      values.forEach((v) => {
        const cell = document.createElement('span');
        cell.className = `mapping-preview-cell${v ? '' : ' is-empty'}`;
        cell.textContent = v || '—';
        cell.title = v || '';
        row.append(cell);
      });
      return row;
    };
    const rows = [makeRow(cols, true)];
    records.slice(0, 2).forEach((rec) => {
      rows.push(makeRow(cols.map((c) => (rec[c] || '').trim()), false));
    });
    previewEl.replaceChildren(...rows);
    previewWrap.style.display = 'block';
  }

  function updateMappingExtras() {
    const allSelected = [nameSelect, emailSelect, managerSelect].every((sel) => sel && sel.value);
    if (!allSelected || !parsedCsv) {
      lastAnalysis = null;
      if (previewWrap) previewWrap.style.display = 'none';
      if (validationEl) validationEl.style.display = 'none';
      return;
    }
    const records = rowsToRecords(parsedCsv.headers, parsedCsv.rows);
    const mapping = {
      nameCol: nameSelect.value,
      emailCol: emailSelect.value,
      managerEmailCol: managerSelect.value,
    };
    renderMappingPreview(records, mapping);

    lastAnalysis = analyzeOrgRecords(records, mapping);
    const a = lastAnalysis;
    if (!validationEl) return;
    const clean = a.unmatched === 0 && a.cycles === 0;
    const parts = [
      `${a.employees} employee${a.employees === 1 ? '' : 's'}`,
      a.roots === 1 ? '1 top-level lead' : `${a.roots} top-level leads`,
      `${a.unmatched} unmatched supervisor${a.unmatched === 1 ? '' : 's'}`,
    ];
    if (a.cycles) parts.push(`${a.cycles} in a manager cycle (placed at top level)`);
    if (a.skipped) parts.push(`${a.skipped} row${a.skipped === 1 ? '' : 's'} skipped (empty name)`);
    validationEl.textContent = `${clean ? '✓' : '⚠'} ${parts.join(' · ')}`;
    validationEl.className = `wizard-banner ${clean ? 'wizard-banner-success' : 'wizard-banner-warn'}`;
    validationEl.style.display = 'flex';
  }

  [nameSelect, emailSelect, managerSelect].forEach((sel, idx) => {
    if (!sel) return;
    const key = ['name', 'email', 'manager'][idx];
    sel.addEventListener('change', () => {
      const badge = autoBadges[key];
      if (badge) badge.style.visibility = 'hidden'; // manual override clears the badge
      checkMappingComplete();
      updateMappingExtras();
    });
  });

  // ── Step 4 helpers ────────────────────────────────────────────────────────

  function getCheckedCount() {
    return fieldsListEl?.querySelectorAll('.field-checkbox:checked').length ?? 0;
  }

  function enforceFieldMax() {
    const count = getCheckedCount();
    fieldsListEl?.querySelectorAll('.field-checkbox').forEach((cb) => {
      if (!cb.checked) cb.disabled = count >= MAX_FIELDS;
    });
  }

  function updateFieldsCounter() {
    if (fieldsCounterEl) fieldsCounterEl.textContent = `${getCheckedCount()} of ${MAX_FIELDS} selected`;
  }

  function renderImportSummary() {
    if (!importSummaryEl) return;
    const layoutLabel = (selectedLayout || 'vertical') === 'horizontal' ? 'Horizontal' : 'Vertical';
    const cardCount = lastAnalysis ? lastAnalysis.employees : (parsedCsv ? parsedCsv.rows.length : 0);
    const fieldCount = getCheckedCount();
    importSummaryEl.replaceChildren();
    const text = document.createElement('span');
    text.append(`${layoutLabel} layout · ${selectedFile ? selectedFile.name : ''} · `);
    const bold = document.createElement('b');
    bold.textContent = `${cardCount} card${cardCount === 1 ? '' : 's'}`;
    text.append(bold);
    text.append(` · ${fieldCount} field${fieldCount === 1 ? '' : 's'} per card`);
    importSummaryEl.append(text);
  }

  function syncSelectAll() {
    if (!selectAllEl || !fieldsListEl) return;
    const total   = fieldsListEl.querySelectorAll('.field-checkbox').length;
    const checked = getCheckedCount();
    if (total === 0) {
      selectAllEl.checked = false;
      selectAllEl.indeterminate = false;
    } else if (checked === total) {
      selectAllEl.checked = true;
      selectAllEl.indeterminate = false;
    } else if (checked === 0) {
      selectAllEl.checked = false;
      selectAllEl.indeterminate = false;
    } else {
      selectAllEl.checked = false;
      selectAllEl.indeterminate = true;
    }
    updateFieldsCounter();
    renderImportSummary();
  }

  function applyFieldsSearch() {
    if (!fieldsListEl) return;
    const query = (fieldsSearchEl?.value || '').trim().toLowerCase();
    let visible = 0;
    fieldsListEl.querySelectorAll('.field-item').forEach((item) => {
      const label = item.textContent.toLowerCase();
      const hide = Boolean(query) && !label.includes(query);
      item.classList.toggle('is-filtered', hide);
      if (!hide) visible += 1;
    });
    let noResults = fieldsListEl.querySelector('.fields-no-results');
    if (!visible) {
      if (!noResults) {
        noResults = document.createElement('p');
        noResults.className = 'fields-no-results';
        noResults.textContent = 'No columns match your search.';
        fieldsListEl.append(noResults);
      }
    } else if (noResults) {
      noResults.remove();
    }
  }

  if (fieldsSearchEl) fieldsSearchEl.addEventListener('input', applyFieldsSearch);

  function populateFieldsList(remainingCols) {
    if (!fieldsListEl) return;
    const items = remainingCols.map((col, i) => {
      const item = document.createElement('div');
      item.className = 'field-item';

      const label = document.createElement('label');
      label.className = 'checkbox';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'field-checkbox';
      checkbox.value = col;
      checkbox.checked = i < MAX_FIELDS;
      checkbox.disabled = i >= MAX_FIELDS;

      const text = document.createElement('span');
      text.textContent = col;

      label.append(checkbox, text);
      item.append(label);
      return item;
    });
    fieldsListEl.replaceChildren(...items);
    if (fieldsSearchEl) fieldsSearchEl.value = '';
    enforceFieldMax();
    syncSelectAll();
    fieldsListEl.querySelectorAll('.field-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => { enforceFieldMax(); syncSelectAll(); });
    });
  }

  // Select-all toggle (wired once; reads live checkboxes from DOM)
  if (selectAllEl) {
    selectAllEl.addEventListener('change', () => {
      const checkboxes = Array.from(fieldsListEl?.querySelectorAll('.field-checkbox') || []);
      if (selectAllEl.checked) {
        checkboxes.forEach((cb, i) => { cb.checked = i < MAX_FIELDS; cb.disabled = false; });
      } else {
        checkboxes.forEach((cb) => { cb.checked = false; cb.disabled = false; });
      }
      enforceFieldMax();
      syncSelectAll();
    });
  }

  // ── Step 3 → Step 4 ───────────────────────────────────────────────────────
  if (mappingNextBtn) {
    mappingNextBtn.addEventListener('click', () => {
      if (!nameSelect?.value || !emailSelect?.value || !managerSelect?.value) return;
      const mappedCols    = new Set([nameSelect.value, emailSelect.value, managerSelect.value]);
      const remainingCols = (parsedCsv?.headers || []).filter((h) => !mappedCols.has(h));
      populateFieldsList(remainingCols);
      showWizardView(viewFields);
    });
  }

  if (fieldsBackBtn) fieldsBackBtn.addEventListener('click', () => showWizardView(viewMapping));

  // ── Progress overlay ──────────────────────────────────────────────────────
  // Cards fill 0–85% of the bar; connectors fill the remaining 15%.
  // The visual counter updates per item; screen-reader announcements are
  // throttled to phase changes + ~10% milestones (a 500-card import would
  // otherwise fire hundreds of aria-live updates).

  const progressTrack    = document.getElementById('progress-track');
  const progressAnnouncer = document.getElementById('progress-announcer');
  let lastAnnouncedDecile = -1;
  let lastAnnouncedPhase  = '';

  function handleProgress({ phase, done, total }) {
    if (!progressBar || !total) return;
    let percent;
    if (phase === 'cards') {
      if (progressPhase) progressPhase.textContent = 'Placing cards on the board';
      if (progressCount) progressCount.textContent = `${done} of ${total} cards`;
      percent = (done / total) * 85;
    } else {
      if (progressPhase) progressPhase.textContent = 'Drawing reporting lines';
      if (progressCount) progressCount.textContent = `${done} of ${total} connectors`;
      percent = 85 + (done / total) * 15;
    }
    progressBar.style.width = `${percent}%`;
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));

    if (progressAnnouncer) {
      const decile = Math.floor(percent / 10);
      if (phase !== lastAnnouncedPhase) {
        lastAnnouncedPhase = phase;
        lastAnnouncedDecile = decile;
        progressAnnouncer.textContent = phase === 'cards'
          ? 'Placing cards on the board'
          : 'Cards placed. Drawing reporting lines';
      } else if (decile > lastAnnouncedDecile) {
        lastAnnouncedDecile = decile;
        progressAnnouncer.textContent = `${Math.round(percent)} percent complete`;
      }
    }
  }

  // ── Create org chart ──────────────────────────────────────────────────────
  if (doneBtn) {
    doneBtn.addEventListener('click', async () => {
      if (!selectedFile) return;
      const fieldCols = Array.from(
        fieldsListEl?.querySelectorAll('.field-checkbox:checked') || [],
      ).map((cb) => cb.value);
      const mapping = {
        nameCol:        nameSelect.value,
        emailCol:       emailSelect.value,
        managerEmailCol: managerSelect.value,
        fieldCols,
        layout:         selectedLayout || 'vertical',
      };
      try {
        if (progressBar)   progressBar.style.width = '0%';
        if (progressCount) progressCount.textContent = '';
        if (progressPhase) progressPhase.textContent = 'Placing cards on the board';
        if (progressTrack) progressTrack.setAttribute('aria-valuenow', '0');
        lastAnnouncedDecile = -1;
        lastAnnouncedPhase = '';
        if (loadingEl)     loadingEl.style.display = 'flex';
        showWizardView(null);
        await createCardsFromCSV(selectedFile, mapping, handleProgress);
        clearFile();
        await miro.board.ui.closeModal();
      } catch (err) {
        console.error(err);
        if (loadingEl) loadingEl.style.display = 'none';
        showWizardView(viewFields);
        await miro.board.notifications.showError(
          'Failed to create cards: ' + (err.message || String(err)),
        );
      }
    });
  }
}

// ─── Conditional Formatting ───────────────────────────────────────────────────

const CARD_THEME_PALETTE = [
  '#f9eeb8', '#f8d84c', '#c58c00', '#f2f2f2',
  '#f7dfc2', '#f9a34b', '#ae5f00', '#dcdcdc',
  '#f7cdcd', '#ff6969', '#d30c0c', '#b5b5b5',
  '#9dddb8', '#35c05a', '#0f7f2d', '#646464',
  '#b8d3f6', '#5f94e0', '#355fae', '#1d1d1f',
  '#d1c9f5', '#8778dd', '#6938cc', '#ff1f1f',
  '#06133a',
];

/**
 * Strip the "Header: " prefix from a field value if it was added by "Include header values".
 * Uses the field's tooltip (the raw header name) to detect the prefix.
 */
function stripHeaderPrefix(value, tooltip) {
  const raw = (value || '').trim();
  const prefix = `${(tooltip || '').trim()}: `;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/** Read a card field’s display value by its tooltip (CSV header); respects “Header: ” prefix stripping. */
function getFieldValueByKey(card, fieldKey) {
  const f = (card.fields || []).find((x) => (x.tooltip || '').trim() === fieldKey);
  if (!f) return '';
  return stripHeaderPrefix(f.value, fieldKey);
}

/** Text conditions compare lowercased strings; numeric ops require both sides to parse as finite numbers. */
function matchesCondition(fieldValue, operator, compareValue) {
  const v = (fieldValue || '').trim().toLowerCase();
  const c = (compareValue || '').trim().toLowerCase();
  // Numeric operators: parse both sides; non-numeric values never match
  if (['numEquals', 'numNotEquals', 'gt', 'gte', 'lt', 'lte'].includes(operator)) {
    const vn = parseFloat(fieldValue);
    const cn = parseFloat(compareValue);
    if (isNaN(vn) || isNaN(cn)) return false;
    switch (operator) {
      case 'numEquals':    return vn === cn;
      case 'numNotEquals': return vn !== cn;
      case 'gt':           return vn > cn;
      case 'gte':          return vn >= cn;
      case 'lt':           return vn < cn;
      case 'lte':          return vn <= cn;
    }
  }
  switch (operator) {
    case 'equals':     return v === c;
    case 'contains':   return v.includes(c);
    case 'notEquals':  return v !== c;
    case 'startsWith': return v.startsWith(c);
    case 'endsWith':   return v.endsWith(c);
    default:           return false;
  }
}

/**
 * Conditional formatting + custom color UI (swatches, HSB gradient popup, EyeDropper when available).
 * Driven live by selectionStore (SDK selection:update) — no Load button. Shows a
 * rule preview and "X of Y cards match" before anything is applied.
 */
function setupConditionalFormatting() {
  const formatSection    = document.getElementById('conditional-format-section');
  const emptyState       = document.getElementById('fmt-empty-state');
  const selectionBanner  = document.getElementById('fmt-selection-banner');
  const formatField      = document.getElementById('format-field');
  const formatOp         = document.getElementById('format-operator');
  const formatValue      = document.getElementById('format-value');
  const formatColor      = document.getElementById('format-color');
  const formatFillBg     = document.getElementById('format-fill-background');
  const applyBtn         = document.getElementById('apply-format');
  const previewCard      = document.getElementById('fmt-preview-card');
  const previewTitle     = document.getElementById('fmt-preview-title');
  const previewField     = document.getElementById('fmt-preview-field');
  const matchBar         = document.getElementById('fmt-match-bar');
  const matchCount       = document.getElementById('fmt-match-count');
  const inlineMsgSlot    = document.getElementById('fmt-inline-msg');
  // ── Gradient color picker ──────────────────────────────────────────────────
  const colorPickerPopup   = document.getElementById('color-picker-popup');
  const cpGradient         = document.getElementById('cp-gradient');
  const cpCursor           = document.getElementById('cp-cursor');
  const cpHueTrack         = document.getElementById('cp-hue-track');
  const cpHueThumb         = document.getElementById('cp-hue-thumb');
  const cpPreview          = document.getElementById('cp-preview');
  const cpEyedropper       = document.getElementById('cp-eyedropper');
  const colorPickerHex     = document.getElementById('color-picker-hex');
  const colorPickerConfirm = document.getElementById('color-picker-confirm');
  if (!formatField || !applyBtn) return;

  let selectedThemeColor = '#5f94e0';
  const customColors = []; // session-only; cleared on every page load

  // ── Color math ──────────────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r,g,b].map(v => clamp(Math.round(v),0,255).toString(16).padStart(2,'0')).join('');
  }

  function rgbToHsb(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else                h = ((r - g) / d + 4) / 6;
    }
    return [Math.round(h * 360), max === 0 ? 0 : Math.round(d / max * 100), Math.round(max * 100)];
  }

  function hsbToRgb(h, s, b) {
    s /= 100; b /= 100;
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = b*(1-s), q = b*(1-f*s), t = b*(1-(1-f)*s);
    const [r,g,bv] = [[b,t,p],[q,b,p],[p,b,t],[p,q,b],[t,p,b],[b,p,q]][i];
    return [r,g,bv].map(v => Math.round(v * 255));
  }

  // ── Picker state (HSB) ──────────────────────────────────────────────────────
  let ph = 200, ps = 60, pb = 80;   // hue 0–360, sat 0–100, bri 0–100

  function updatePickerUI() {
    if (!cpGradient) return;
    // Gradient base colour = pure hue
    cpGradient.style.backgroundColor = `hsl(${ph}, 100%, 50%)`;

    // Cursor position
    const gw = cpGradient.offsetWidth, gh = cpGradient.offsetHeight;
    if (gw && gh) {
      cpCursor.style.left = (ps / 100 * gw) + 'px';
      cpCursor.style.top  = ((100 - pb) / 100 * gh) + 'px';
    }

    // Hue thumb position
    const hw = cpHueTrack ? cpHueTrack.offsetWidth : 0;
    if (hw && cpHueThumb) cpHueThumb.style.left = (ph / 360 * hw) + 'px';

    // Preview and hex input
    const hex = rgbToHex(...hsbToRgb(ph, ps, pb));
    if (cpPreview) cpPreview.style.backgroundColor = hex;
    if (colorPickerHex) colorPickerHex.value = hex.toUpperCase();
  }

  // ── Open popup anchored to the "+" button ───────────────────────────────────
  // Dialog-pattern focus management: focus moves into the popup (hex input) on
  // open; Esc or outside-click closes and restores focus to the opener.

  let pickerOpener = null;

  function openColorPickerPopup(anchorEl) {
    if (!colorPickerPopup) return;
    pickerOpener = anchorEl;
    const [r,g,b] = hexToRgb(selectedThemeColor);
    [ph, ps, pb] = rgbToHsb(r, g, b);

    const anchorRect = anchorEl.getBoundingClientRect();
    const popW = 224, popH = 290;
    let left = anchorRect.left;
    let top  = anchorRect.bottom + 6;
    if (left + popW > window.innerWidth  - 8) left = window.innerWidth  - popW - 8;
    if (top  + popH > window.innerHeight - 8) top  = anchorRect.top - popH - 6;

    colorPickerPopup.style.left = left + 'px';
    colorPickerPopup.style.top  = top  + 'px';
    colorPickerPopup.classList.add('is-open');
    requestAnimationFrame(() => {
      updatePickerUI();
      if (colorPickerHex) colorPickerHex.focus({ preventScroll: true });
    });
  }

  function closeColorPickerPopup(restoreFocus = false) {
    if (!colorPickerPopup || !colorPickerPopup.classList.contains('is-open')) return;
    colorPickerPopup.classList.remove('is-open');
    if (restoreFocus && pickerOpener && document.contains(pickerOpener)) {
      pickerOpener.focus({ preventScroll: true });
    }
    pickerOpener = null;
  }

  // Esc closes the picker and returns focus to the "+" swatch (WCAG dialog pattern)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && colorPickerPopup?.classList.contains('is-open')) {
      e.stopPropagation();
      closeColorPickerPopup(true);
    }
  });

  // ── Gradient drag ───────────────────────────────────────────────────────────
  if (cpGradient) {
    const onGradientMove = (e) => {
      const rect = cpGradient.getBoundingClientRect();
      ps = Math.round(clamp((e.clientX - rect.left) / rect.width,  0, 1) * 100);
      pb = Math.round(clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1) * 100);
      updatePickerUI();
    };
    cpGradient.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onGradientMove(e);
      const up = () => { document.removeEventListener('mousemove', onGradientMove); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', onGradientMove);
      document.addEventListener('mouseup', up);
    });
  }

  // ── Hue slider drag ─────────────────────────────────────────────────────────
  if (cpHueTrack) {
    const onHueMove = (e) => {
      const rect = cpHueTrack.getBoundingClientRect();
      ph = Math.round(clamp((e.clientX - rect.left) / rect.width, 0, 1) * 360);
      if (ph >= 360) ph = 359;
      updatePickerUI();
    };
    cpHueTrack.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onHueMove(e);
      const up = () => { document.removeEventListener('mousemove', onHueMove); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', onHueMove);
      document.addEventListener('mouseup', up);
    });
  }

  // ── Hex input ───────────────────────────────────────────────────────────────
  if (colorPickerHex) {
    colorPickerHex.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        const [r,g,b] = hexToRgb(val);
        [ph, ps, pb] = rgbToHsb(r, g, b);
        updatePickerUI();
      }
    });
  }

  // ── Eyedropper (Chrome 95+ EyeDropper API) ──────────────────────────────────
  if (cpEyedropper) {
    if (!window.EyeDropper) cpEyedropper.style.display = 'none';
    cpEyedropper.addEventListener('click', async () => {
      try {
        const result = await new EyeDropper().open();
        const hex = result.sRGBHex;
        const [r,g,b] = hexToRgb(hex);
        [ph, ps, pb] = rgbToHsb(r, g, b);
        colorPickerPopup.classList.add('is-open');
        requestAnimationFrame(updatePickerUI);
      } catch (_) { /* user cancelled */ }
    });
  }

  // ── Confirm: add to session palette ─────────────────────────────────────────
  if (colorPickerConfirm) {
    colorPickerConfirm.addEventListener('click', () => {
      const hex = rgbToHex(...hsbToRgb(ph, ps, pb)).toLowerCase();
      if (!CARD_THEME_PALETTE.includes(hex) && !customColors.includes(hex)) customColors.push(hex);
      selectedThemeColor = hex;
      renderColorSwatches();
      refreshMatch();
      closeColorPickerPopup();
      // Land keyboard focus on the swatch that was just added/selected
      formatColor?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    });
  }

  // ── Close on outside click ──────────────────────────────────────────────────
  if (colorPickerPopup) colorPickerPopup.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closeColorPickerPopup()); // outside click: close, don't move focus

  // ── Swatch rendering ────────────────────────────────────────────────────────
  function renderColorSwatches() {
    if (!formatColor) return;
    const allColors = [...CARD_THEME_PALETTE, ...customColors];
    const swatches = allColors.map((hex) => {
      const swatch = document.createElement('button');
      const isCustom = customColors.includes(hex);
      swatch.type = 'button';
      swatch.className = `color-swatch-btn${isCustom ? ' color-swatch-custom' : ''}`;
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-label', `Color ${hex}`);
      const isSelected = hex.toLowerCase() === selectedThemeColor.toLowerCase();
      swatch.setAttribute('aria-checked', String(isSelected));
      swatch.tabIndex = isSelected ? 0 : -1; // roving tabindex: grid is one tab stop
      swatch.dataset.color = hex;
      swatch.style.backgroundColor = hex;
      if (hex === '#f2f2f2' || hex === '#ffffff') swatch.style.border = '1px solid #cfcfcf';

      if (isCustom) {
        const tooltip = document.createElement('span');
        tooltip.className = 'swatch-hex-tooltip';
        tooltip.textContent = hex.toUpperCase();
        swatch.append(tooltip);
      }
      return swatch;
    });

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'color-swatch-btn color-swatch-add';
    addButton.setAttribute('aria-label', 'Add custom color');
    addButton.tabIndex = -1; // reachable via arrow keys within the grid
    addButton.append('+');

    const addTooltip = document.createElement('span');
    addTooltip.className = 'swatch-add-tooltip';
    addTooltip.textContent = 'Add a custom color';
    addButton.append(addTooltip);

    formatColor.replaceChildren(...swatches, addButton);
  }

  renderColorSwatches();

  if (formatColor) {
    formatColor.addEventListener('click', (e) => {
      const t = e.target instanceof HTMLElement ? e.target.closest('.color-swatch-btn') : null;
      if (!t) return;
      if (t.classList.contains('color-swatch-add')) {
        openColorPickerPopup(t);
        e.stopPropagation();
        return;
      }
      const hex = t.dataset.color;
      if (hex) {
        selectedThemeColor = hex;
        renderColorSwatches();
        refreshMatch();
        // keep keyboard focus on the newly selected swatch after re-render
        formatColor.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
      }
    });

    // Arrow-key navigation within the swatch radiogroup (single tab stop)
    formatColor.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const btns = Array.from(formatColor.querySelectorAll('.color-swatch-btn'));
      const idx = btns.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      btns[(idx + delta + btns.length) % btns.length].focus();
    });
  }

  // ── Live selection → rule state ─────────────────────────────────────────────

  /** Convert #rrggbb to a translucent rgba() for the preview fill. */
  function hexWithAlpha(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function computeMatches() {
    const fieldKey = formatField.value;
    if (!fieldKey) return [];
    return selectionStore.cards.filter((card) =>
      matchesCondition(getFieldValueByKey(card, fieldKey), formatOp.value, formatValue.value),
    );
  }

  /** Recompute match count, preview card, and Apply button state. */
  function refreshMatch() {
    if (!matchBar || !matchCount) return;
    const total = selectionStore.cards.length;
    const matches = computeMatches();

    matchBar.style.width = total ? `${(matches.length / total) * 100}%` : '0%';
    matchCount.textContent = `${matches.length} of ${total} card${total === 1 ? '' : 's'} match`;

    applyBtn.disabled = matches.length === 0;
    applyBtn.textContent = matches.length
      ? `Apply to ${matches.length} card${matches.length === 1 ? '' : 's'}`
      : 'Apply to matching cards';

    if (previewCard) {
      const sample = matches[0] || selectionStore.cards[0];
      if (previewTitle) previewTitle.textContent = sample?.title || 'Card title';
      const fieldKey = formatField.value;
      if (previewField) {
        previewField.textContent = sample && fieldKey
          ? `${fieldKey}: ${getFieldValueByKey(sample, fieldKey) || '—'}`
          : '';
      }
      previewCard.style.borderLeftColor = selectedThemeColor;
      previewCard.style.background = formatFillBg?.checked
        ? hexWithAlpha(selectedThemeColor, 0.14)
        : '#fff';
    }
  }

  /** React to selection changes: banner, field options, empty state. */
  function refreshFromSelection(cards) {
    if (!cards.length) {
      if (selectionBanner) selectionBanner.classList.remove('is-visible');
      if (emptyState) emptyState.style.display = 'block';
      if (formatSection) formatSection.style.display = 'none';
      return;
    }

    const fieldKeysSet = new Set();
    for (const card of cards) {
      (card.fields || []).forEach((f) => {
        const k = (f.tooltip || '').trim();
        if (k) fieldKeysSet.add(k);
      });
    }
    const fieldKeys = [...fieldKeysSet].sort();

    if (selectionBanner) {
      selectionBanner.textContent =
        `${cards.length} card${cards.length === 1 ? '' : 's'} selected · ` +
        `${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'} detected`;
      selectionBanner.classList.add('is-visible');
    }

    if (!fieldKeys.length) {
      if (emptyState) emptyState.style.display = 'block';
      if (formatSection) formatSection.style.display = 'none';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (formatSection) formatSection.style.display = 'block';

    // Preserve the user's field choice across selection updates when possible
    const previous = formatField.value;
    setSelectOptions(formatField, fieldKeys);
    if (fieldKeys.includes(previous)) formatField.value = previous;

    refreshMatch();
  }

  selectionStore.subscribe(refreshFromSelection);

  formatField.addEventListener('change', refreshMatch);
  if (formatOp) formatOp.addEventListener('change', refreshMatch);
  if (formatValue) formatValue.addEventListener('input', refreshMatch);
  if (formatFillBg) formatFillBg.addEventListener('change', refreshMatch);

  // ── Apply ───────────────────────────────────────────────────────────────────

  applyBtn.addEventListener('click', async () => {
    const fieldKey = formatField.value;
    if (!fieldKey) {
      showInlineMessage(inlineMsgSlot, 'error', 'Select a field first.');
      return;
    }
    const matches = computeMatches();
    if (!matches.length) {
      showInlineMessage(inlineMsgSlot, 'error', 'No selected cards match this rule.');
      return;
    }
    const hexColor = selectedThemeColor;
    const fillBg = formatFillBg?.checked ?? false;
    try {
      for (const card of matches) {
        card.style = card.style || {};
        card.style.cardTheme = hexColor;
        card.style.fillBackground = fillBg;
        await card.sync();
      }
      // Board notification once everything has synced, so users know the work
      // is complete (https://developers.miro.com/docs/websdk-reference-notifications)
      await miro.board.notifications.showInfo(
        `Formatting applied to ${matches.length} card${matches.length === 1 ? '' : 's'}`,
      );
      showInlineMessage(
        inlineMsgSlot,
        'success',
        `Formatting applied to ${matches.length} card${matches.length === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      console.error(err);
      showInlineMessage(
        inlineMsgSlot,
        'error',
        'Failed to apply format: ' + (err.message || String(err)),
      );
    }
  });
}

// ─── Single Card Details ──────────────────────────────────────────────────────
// app.html only. Driven live by selectionStore: exactly one selected card shows
// its identity block + fields. View mode renders plain text rows (definition
// list); inputs only appear in Edit mode. Save persists via card.sync() and
// preserves "Header: " prefixes added by "Include header values".

function setupSingleCardDetails() {
  const section    = document.getElementById('single-card-section');
  const emptyState = document.getElementById('details-empty-state');
  const emptyTitle = document.getElementById('details-empty-title');
  const emptyText  = document.getElementById('details-empty-text');
  const subtitle   = document.getElementById('details-subtitle');
  const nameEl     = document.getElementById('single-card-name');
  const avatarEl   = document.getElementById('card-avatar');
  const metaEl     = document.getElementById('card-meta');
  const fieldsEl   = document.getElementById('single-card-fields');
  const editBtn    = document.getElementById('edit-card-fields-btn');
  const editLabel  = document.getElementById('edit-card-fields-label');
  const saveBtn    = document.getElementById('save-card-fields-btn');
  const msgSlot    = document.getElementById('details-inline-msg');
  if (!fieldsEl || !editBtn) return;

  let currentCard = null;
  let isEditing   = false;

  const initials = (title) => {
    const parts = (title || '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  };

  function renderViewMode() {
    const fields = currentCard?.fields || [];
    if (!fields.length) {
      const empty = document.createElement('p');
      empty.className = 'p-small';
      empty.textContent = 'This card has no fields.';
      fieldsEl.replaceChildren(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'field-view-list';
    fields.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'field-view-row';
      const label = document.createElement('span');
      label.className = 'field-view-label';
      label.textContent = f.tooltip || `Field ${i + 1}`;
      const value = document.createElement('span');
      value.className = 'field-view-value';
      value.textContent = stripHeaderPrefix(f.value, f.tooltip) || '—';
      row.append(label, value);
      list.append(row);
    });
    fieldsEl.replaceChildren(list);
  }

  function renderEditMode() {
    const fields = currentCard?.fields || [];
    const rows = fields.map((f, i) => {
      const row = document.createElement('div');
      row.className = 'field-edit-row';
      const label = document.createElement('label');
      label.textContent = f.tooltip || `Field ${i + 1}`;
      label.htmlFor = `card-field-input-${i}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input card-field-input';
      input.id = `card-field-input-${i}`;
      input.dataset.fieldIndex = String(i);
      input.value = stripHeaderPrefix(f.value, f.tooltip);
      row.append(label, input);
      return row;
    });
    fieldsEl.replaceChildren(...rows);
  }

  function exitEditMode() {
    isEditing = false;
    if (editLabel) editLabel.textContent = 'Edit';
    saveBtn.style.display = 'none';
    renderViewMode();
  }

  function showCard(card) {
    currentCard = card;
    if (nameEl) nameEl.textContent = card.title || '(untitled)';
    if (avatarEl) avatarEl.textContent = initials(card.title);
    if (metaEl) {
      const n = (card.fields || []).length;
      metaEl.textContent = `${n} field${n === 1 ? '' : 's'}`;
    }
    if (subtitle) subtitle.textContent = 'Updates live with your selection';
    editBtn.disabled = !(card.fields || []).length;
    exitEditMode();
    if (emptyState) emptyState.style.display = 'none';
    if (section) section.style.display = 'block';
  }

  function showEmpty(kind) {
    currentCard = null;
    isEditing = false;
    if (section) section.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';
    if (subtitle) subtitle.textContent = 'Select a single card on the board';
    if (kind === 'multi') {
      if (emptyTitle) emptyTitle.textContent = 'Multiple cards selected';
      if (emptyText) emptyText.textContent = 'Select just one card on the board to view or edit its fields.';
    } else {
      if (emptyTitle) emptyTitle.textContent = 'No card selected';
      if (emptyText) emptyText.textContent = 'Select a single card on the board to view or edit its fields. The panel updates automatically.';
    }
  }

  selectionStore.subscribe((cards) => {
    // Don't clobber in-flight edits when the same card re-emits (e.g. after sync)
    if (isEditing && currentCard && cards.length === 1 && cards[0].id === currentCard.id) return;
    if (cards.length === 1) showCard(cards[0]);
    else showEmpty(cards.length ? 'multi' : 'none');
  });

  editBtn.addEventListener('click', () => {
    if (!currentCard) return;
    isEditing = !isEditing;
    if (isEditing) {
      renderEditMode();
      if (editLabel) editLabel.textContent = 'Cancel';
      saveBtn.style.display = 'block';
    } else {
      exitEditMode(); // Cancel: revert without syncing
    }
  });

  saveBtn.addEventListener('click', async () => {
    if (!currentCard) return;
    const fields = (currentCard.fields || []).map((f, i) => {
      const input = fieldsEl.querySelector(`[data-field-index="${i}"]`);
      if (!input) return f;
      const editedValue = input.value;
      // Re-apply the "Header: " prefix if the original value had it
      const prefix = `${(f.tooltip || '').trim()}: `;
      const hadPrefix = (f.value || '').trim().startsWith(prefix);
      return { ...f, value: hadPrefix ? `${prefix}${editedValue}` : editedValue };
    });
    try {
      currentCard.fields = fields;
      await currentCard.sync();
      exitEditMode();
      showInlineMessage(msgSlot, 'success', 'Card fields updated.');
    } catch (err) {
      console.error(err);
      showInlineMessage(msgSlot, 'error', 'Failed to save changes: ' + (err.message || String(err)));
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Each setup function guards against missing elements, so this single init()
// works for both app.html (panel) and create-chart.html (modal): each page
// only has the elements it needs and the rest of the setup calls return early.

function init() {
  const setupAll = () => {
    setupPanelNav();
    setupCreateChartButton();
    setupFeedbackButton();
    setupTooltipDismissal();
    setupModalInitialFocus();
    setupFileUpload();
    setupConditionalFormatting();
    setupSingleCardDetails();
    setupSelectionWatcher(); // last: subscribers above receive the initial selection
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll);
  } else {
    setupAll();
  }
}

init();
