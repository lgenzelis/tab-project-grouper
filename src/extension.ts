import * as vscode from 'vscode';

let output: vscode.OutputChannel;

// Guards against re-entrancy: our own moveActiveEditor calls can fire tab-change
// events, and we don't want to react to changes we caused ourselves.
let busy = false;

// Tabs we've already grouped once (keyed by group + uri). A tab is positioned
// exactly when it first becomes permanent; afterwards we leave it alone so we
// never yank a tab around on saves, focus changes, or manual reordering.
const positioned = new Set<string>();

function tabKey(uri: vscode.Uri, group: vscode.TabGroup): string {
  return `${group.viewColumn}::${uri.toString()}`;
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Tab Project Grouper');
  context.subscriptions.push(output);

  // Seed with everything already open so we don't rearrange pre-existing tabs
  // the first time the user interacts with them.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = uriOf(tab);
      if (uri && !tab.isPreview) {
        positioned.add(tabKey(uri, group));
      }
    }
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(handleTabChange)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tabProjectGrouper.regroupAll', regroupAll)
  );

  log('Tab Project Grouper activated.');
}

export function deactivate() {
  // OutputChannel is disposed via context.subscriptions.
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('tabProjectGrouper')
    .get<boolean>('enabled', true);
}

function log(message: string) {
  output.appendLine(message);
}

async function handleTabChange(e: vscode.TabChangeEvent) {
  if (busy || !isEnabled()) {
    return;
  }

  // Drop closed tabs from the "already grouped" set so reopening them later
  // re-groups them.
  for (const tab of e.closed) {
    const uri = uriOf(tab);
    if (uri) {
      positioned.delete(tabKey(uri, tab.group));
    }
  }

  // Bulk opens (session restore, "open folder") shouldn't thrash: mark them as
  // already-placed and skip.
  if (e.opened.length > 1) {
    for (const tab of e.opened) {
      const uri = uriOf(tab);
      if (uri && !tab.isPreview) {
        positioned.add(tabKey(uri, tab.group));
      }
    }
    return;
  }

  // A tab becomes groupable either when it opens as a permanent tab, or when a
  // preview tab is promoted to permanent (which fires `changed`, not `opened`).
  // We only ever move the active tab of the active group, and only once.
  const candidate = [...e.opened, ...e.changed].find(
    (t) => t.isActive && t.group.isActive && !t.isPreview && !t.isPinned
  );
  if (!candidate) {
    return;
  }

  const uri = uriOf(candidate);
  if (!uri) {
    return;
  }

  const key = tabKey(uri, candidate.group);
  if (positioned.has(key)) {
    return; // Already grouped once — leave it where it is.
  }
  positioned.add(key);

  await repositionNewTab(candidate);
}

/**
 * Slide a freshly-opened tab so it sits immediately to the right of the
 * right-most already-open tab from the same project. If no same-project tab
 * exists, move it to the far right of its group.
 */
async function repositionNewTab(tab: vscode.Tab) {
  // We can only move the *active* editor of the *active* group via the
  // built-in command, so bail out if this tab isn't it.
  if (!tab.isActive || !tab.group.isActive) {
    return;
  }

  // Pinned tabs live in their own region at the front of the bar; reordering
  // across the pinned/unpinned boundary is fragile, so leave them alone.
  if (tab.isPinned) {
    return;
  }

  const uri = uriOf(tab);
  if (!uri) {
    return; // Non-file tab (settings, webview, etc.) — no project to group by.
  }

  const project = projectKey(uri);
  const tabs = tab.group.tabs;
  const newIndex = tabs.indexOf(tab);
  if (newIndex < 0) {
    return;
  }

  // Find the right-most tab (excluding this one) belonging to the same project.
  let targetIndex = -1;
  for (let i = 0; i < tabs.length; i++) {
    const other = tabs[i];
    if (other === tab || other.isPinned) {
      continue;
    }
    const otherUri = uriOf(other);
    if (otherUri && projectKey(otherUri) === project) {
      targetIndex = i; // keep last match → right-most
    }
  }

  if (targetIndex === -1) {
    // No sibling from this project. Send it to the far right.
    if (newIndex !== tabs.length - 1) {
      await runExclusively(() =>
        vscode.commands.executeCommand('moveActiveEditor', {
          to: 'last',
          by: 'tab',
        })
      );
      log(`Moved ${describe(uri)} to far right (no same-project sibling).`);
    }
    return;
  }

  // Move the new tab to sit immediately to the right of targetIndex.
  if (newIndex > targetIndex) {
    const steps = newIndex - (targetIndex + 1);
    if (steps > 0) {
      await runExclusively(() =>
        vscode.commands.executeCommand('moveActiveEditor', {
          to: 'left',
          by: 'tab',
          value: steps,
        })
      );
      log(`Moved ${describe(uri)} left ${steps} to group with ${project}.`);
    }
  } else {
    // newIndex < targetIndex: removing the new tab shifts the target left by
    // one, so the new tab's final slot is `targetIndex - newIndex` to the right.
    const steps = targetIndex - newIndex;
    if (steps > 0) {
      await runExclusively(() =>
        vscode.commands.executeCommand('moveActiveEditor', {
          to: 'right',
          by: 'tab',
          value: steps,
        })
      );
      log(`Moved ${describe(uri)} right ${steps} to group with ${project}.`);
    }
  }
}

/**
 * Re-sort every tab in the active group so projects form contiguous blocks,
 * preserving each tab's existing relative order within its project. Triggered
 * manually via the command palette.
 */
async function regroupAll() {
  const group = vscode.window.tabGroups.activeTabGroup;

  // Snapshot the unpinned text tabs in their current order. (Only text tabs:
  // we re-focus each via showTextDocument to move it.)
  const movable = group.tabs.filter(
    (t) => !t.isPinned && t.input instanceof vscode.TabInputText
  );

  // Stable bucket order: first time we see a project, that's its slot.
  const order: string[] = [];
  const buckets = new Map<string, vscode.Uri[]>();
  for (const t of movable) {
    const uri = (t.input as vscode.TabInputText).uri;
    const key = projectKey(uri);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(uri);
  }

  const desired: vscode.Uri[] = [];
  for (const key of order) {
    desired.push(...buckets.get(key)!);
  }

  // Focus each tab in the desired order and push it to the end. After all of
  // them are pushed in order, they end up in exactly that order.
  // (showTextDocument only *focuses* an already-open tab; moveActiveEditor is
  // what actually reorders it.)
  await runExclusively(async () => {
    for (const uri of desired) {
      await vscode.window.showTextDocument(uri, {
        viewColumn: group.viewColumn,
        preview: false,
        preserveFocus: false,
      });
      await vscode.commands.executeCommand('moveActiveEditor', {
        to: 'last',
        by: 'tab',
      });
    }
  });

  log(`Regrouped ${desired.length} tabs across ${order.length} project(s).`);
}

async function runExclusively(fn: () => Thenable<unknown> | Promise<unknown>) {
  busy = true;
  try {
    await fn();
  } catch (err) {
    log(`Error while repositioning: ${String(err)}`);
  } finally {
    busy = false;
  }
}

/** The URI backing a tab, if it is a normal text/notebook/custom editor. */
function uriOf(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}

/**
 * A stable key identifying the project a URI belongs to. Files inside a
 * workspace folder key on that folder; everything else shares the "<no project>"
 * bucket so loose files group together.
 */
function projectKey(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder ? folder.uri.toString() : '<no project>';
}

function describe(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.toString();
}
