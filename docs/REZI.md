# Rezi — Full terminal GUI (Node/Bun)

[Rezi](https://rezitui.dev/) is a TypeScript TUI framework that gives a **full terminal GUI** feel: many widgets, native-speed rendering, and layouts that fit the terminal.

**Runtime:** Node.js and Bun only (no Deno). Uses a native C rendering engine (Zireael) for layout and painting.

## Why Rezi

- **56 built-in widgets** — Tables, modals, command palette, code editor, charts (sparklines, bar, line, gauges), canvas, buttons, tabs, etc.
- **Two syntaxes** — Functional `ui.*` API or JSX (no React runtime). Same engine.
- **Layout** — Column/row/grid, flex-style, so you can do 2–3 column PR lists and a filter bar.
- **Performance** — Hot path (layout, diff, paint) runs in native C; much faster than pure-JS TUIs in benchmarks.
- **TypeScript** — Typed APIs and strict mode.

Good fit when you want: multi-column lists, filter-as-you-type, arrow-key selection, and a cursor below the list — i.e. a small “app” in the terminal rather than a single prompt.

## Getting started

```bash
npm create rezi my-app
cd my-app && npm run dev
```

Docs: [rezitui.dev/docs](https://rezitui.dev/docs). Widget reference: [rezitui.dev/docs/widgets](https://rezitui.dev/docs/widgets).

## For Git Happens

If we ever move the PR picker off Deno (e.g. to Node/Bun), Rezi would be the natural choice for:

- **Assigned** vs **Review requested** sections
- **2–3 column** PR list that fits the terminal width
- **Filter** input below the list, **arrow keys** to select, **size (additions/deletions)** in each cell, **sort by size**

We’re staying on **Cliffy** on Deno for now; this doc is for when we consider a Rezi-based UI.
