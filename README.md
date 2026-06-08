# Tab Project Grouper

In multi-root workspaces, keeps editor tabs grouped by their project (workspace
folder) so you can tell at a glance which project a tab belongs to.

When you open a file, its tab is slid so it sits immediately to the right of the
right-most already-open tab from the same project. If no tab from that project
is open yet, the new tab goes to the far right of the group.

## How it works

- Listens to `vscode.window.tabGroups.onDidChangeTabs` for single new opens.
- Determines a tab's project via `workspace.getWorkspaceFolder(uri)`.
- Repositions the live tab using the built-in `moveActiveEditor` command — no
  closing/reopening, so no flicker or lost editor state.

## Scope / limitations

- Groups a tab the moment it first becomes **permanent** — either it opens as a
  permanent tab, or a **preview** tab is promoted (edited / double-clicked).
  Transient preview tabs are never moved, so this works with preview-on-click
  either enabled or disabled.
- Each tab is positioned **exactly once**; it's never yanked around afterward on
  saves, focus changes, or if you manually reorder it.
- Bulk opens (session restore, "open folder") are left as-is.
- Only repositions the tab if it is the **active** tab of the **active** group
  (a `moveActiveEditor` constraint).
- **Pinned** tabs are left alone.
- Loose files outside any workspace folder share one `<no project>` bucket.
- Pairs well with `"workbench.editor.labelFormat": "short"`, which prints the
  containing folder in each tab label.

## Develop / run

```bash
npm install
npm run compile      # or: npm run watch
```

Then press **F5** in VS Code to launch an Extension Development Host with the
extension loaded. Open files from different projects in a multi-root workspace
to see them group.

## Commands

- **Tab Project Grouper: Regroup all tabs by project** — re-sorts every tab in
  the active group into contiguous per-project blocks (reopens editors in order;
  use when tabs have drifted out of grouping).

## Settings

- `tabProjectGrouper.enabled` (default `true`) — toggle automatic repositioning.

## Source & deployment

This directory is the editable **source**, kept in
`~/vscode_lgenzelis_extensions/tab-project-grouper/` — separate from the
**installed** copy VS Code loads
(`~/.vscode/extensions/lgenzelis.tab-project-grouper-0.0.1/`).

Unlike the other two extensions, this is a TypeScript project. To compile and
deploy your edits to the installed copy in one step:

```bash
./deploy.sh
```

`deploy.sh` runs `npm run compile` (`src/` → `out/`), then installs a flat
runtime copy: it copies `out/extension.js`, `README.md`, and a `package.json`
with `main` rewritten to `./extension.js` (and `scripts`/`devDependencies`
stripped) into `~/.vscode/extensions/<publisher>.<name>-<version>/`. Reload VS
Code afterward (`Cmd+Shift+P → Developer: Reload Window`). Bumping `version` in
`package.json` creates a new versioned install folder.
