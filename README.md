# Org Network Analysis Tool

A standalone, browser-based **Organisational Network Analysis (ONA)** tool built with D3 v7. Visualise and analyse the relationships between people in your organisation — no server, no login, no data leaves your device.

**Live tool:** [parkcoll.github.io/looker_force_directed_graph](https://parkcoll.github.io/looker_force_directed_graph)

![Org Network Analysis](assets/force-directed.svg)

---

## What it does

Upload a CSV of relationships (who communicates with whom, and how often) and the tool produces an interactive force-directed graph with a full suite of network analysis features.

---

## Getting started

### CSV format

The tool accepts a comma- or tab-separated file with the following columns:

| Column | Required | Description |
|---|---|---|
| `source_node` | ✓ | Name of the person initiating the connection |
| `destination_node` | ✓ | Name of the person receiving the connection |
| `edge_weight` | | Strength of the relationship (defaults to 1) |
| `source_group` | | Team / department of the source person |
| `destination_group` | | Team / department of the destination person |
| `source_level` | | Seniority level of source (1 = junior, higher = senior) |
| `destination_level` | | Seniority level of destination (1 = junior, higher = senior) |

Column names are flexible — the tool recognises common alternatives such as `from`, `to`, `weight`, `team_a`, `dept_b`, etc.

**Minimal example:**
```
source_node,destination_node,edge_weight,source_group,destination_group
Alice,Bob,5,Engineering,Product
Bob,Carol,3,Product,Leadership
```

**With seniority levels:**
```
source_node,destination_node,edge_weight,source_group,destination_group,source_level,destination_level
Alice,Bob,5,Engineering,Product,2,4
```

### Sample datasets

Three built-in samples are available from the load screen:
- **20 people** — small named dataset across 5 teams, good for exploring features
- **100 people** — medium dataset across 8 teams
- **2 000 people** — large procedurally generated dataset for performance testing

---

## Analysis features

Open the **Analyse** panel (▶ Analyse button or press `A`) to access all metrics.

### Metrics tabs

| Tab | What it measures |
|---|---|
| **In Demand** | In-degree — how often others reach out to this person. High scores indicate sought-after people; very high scores can signal bottlenecks. |
| **Influencers** | Out-degree — how actively this person reaches out to others. High scorers drive conversations and spread ideas. |
| **Connectors** | Betweenness centrality — how often this person sits on the shortest path between two others. Bridges between teams. |
| **Networkers** | Total connections in + out. Social hubs useful for spreading messages quickly. |
| **Reach** | Closeness centrality — how quickly this person can reach everyone else. News that starts with them spreads fastest. |
| **Silos** | Group insularity scores, a cross-team connection matrix, and per-group internal vs external connection breakdown. |
| **Change Agents** | Composite score: cross-team diversity (35%) + betweenness (30%) + closeness (20%) + out-degree (15%). People best placed to drive change without being single points of failure. |
| **Hidden Talent** | Composite score: in-demand (45%) + cross-team demand (35%) + junior position (20%). Highly sought-after people who are lower in the hierarchy — often overlooked for promotion. |

### Silo analysis

The Silos tab provides three views:
- **Insularity bars** — each group ranked by % of connections that stay within the team (red = highly siloed)
- **Connection matrix** — N×N heatmap showing connection weight between every pair of groups
- **Cross-team toggle** — grey out all within-team edges so only cross-team connections are visible

### Change tools (⚡ Change button)

- **Change Agents** — ranks people by the composite change-agent score and highlights them on the graph
- **Seed Group Finder** — greedy set-cover algorithm that finds the minimum number of people needed to reach the entire organisation within 2 hops. Shows cumulative coverage per seed added.

---

## Graph controls

### Toolbar

| Button | Shortcut | Action |
|---|---|---|
| ⊕ Fit | `F` | Fit the entire graph into view |
| 🔍 Search | `/` | Highlight nodes by name |
| ↓ Export | | Export PNG, SVG, metrics CSV, or connections CSV |
| ⚙ Settings | | Open the settings panel |
| ⚡ Change | | Change Agents or Seed Group Finder |
| ⟷ Cross-team | | Toggle — show only cross-team edges |
| ⬡ Group View | | Collapse nodes into group bubbles (double-click to expand) |
| ◉ Detect Groups | | Auto-detect communities via label propagation |
| ⚡ If they left… | | Simulate removing the selected person and see the impact |
| ❤ Health | `H` | Network health report (density, silo score, fragility, etc.) |
| ▶ Analyse | `A` | Open / close the analysis panel |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `F` | Fit view |
| `A` | Toggle analysis panel |
| `H` | Network health overlay |
| `/` | Open search |
| `Escape` | Clear selection / close search |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom |

### Interaction

- **Click** a node to select it and see its metrics
- **Drag** a node to reposition it
- **Scroll / pinch** to zoom
- **Click** the background to deselect

---

## Settings panel

Accessible via ⚙ Settings. Controls include:

- **Min edge weight** — filter out weak connections
- **Max nodes** — limit the graph to the N most connected people
- **Exclude groups** — hide entire teams from the graph
- **Node size** — scale nodes by in-degree, out-degree, or fixed size
- **Edge opacity** — adjust link visibility
- **Link distance / repulsion / gravity** — tune the force layout
- **Show labels** — toggle name labels
- **Show arrows** — toggle directional arrows
- **Canvas renderer** — switch to a WebGL-like canvas renderer for large graphs (2 000+ nodes)
- **Theme** — Light / Dark / Corporate / Neon

---

## Themes

| Theme | Description |
|---|---|
| Light | White background, suitable for presentations and screenshots |
| Dark | Dark navy, easy on the eyes |
| Corporate | Deep blue, professional |
| Neon | Black with cyan accents |

---

## Export

The ↓ Export menu provides:

| Format | Contents |
|---|---|
| **PNG** | Screenshot of the current graph view |
| **SVG** | Vector export (SVG renderer mode only) |
| **Metrics CSV** | All computed scores per person (in-degree, betweenness, change agent score, hidden talent score, etc.) |
| **Connections CSV** | Raw edge list with weights |

---

## Technical notes

- **No data leaves your browser.** Everything is computed client-side.
- Built with [D3 v7](https://d3js.org/) — force simulation, zoom, drag, hulls.
- Betweenness centrality uses a Brandes algorithm, approximated for graphs over 400 nodes (sampled source set, linearly rescaled).
- Closeness centrality uses Wasserman–Faust normalisation to handle disconnected graphs.
- Community detection uses label propagation.
- The Seed Group Finder uses a greedy set-cover over 2-hop neighbourhoods.
- Canvas renderer uses `devicePixelRatio` scaling for crisp rendering on retina/HiDPI screens.
- Responsive and mobile-friendly, including iOS Safari safe-area handling.

---

## Development

```bash
# Install dependencies
npm install --legacy-peer-deps

# Build forcedirected.js from src/
npm run build
```

The main application is a single self-contained file: `index.html`. The `src/` directory contains the original Looker custom visualisation source (TypeScript/webpack).

GitHub Actions automatically builds `forcedirected.js` on push to `master` and deploys `index.html` to GitHub Pages.
