import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { setThemePreference, type ThemeId } from '../components/app-theme';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ColorField } from '../components/controls/ColorField';
import { useDismissable } from '../components/dismiss';
import { ThemePicker } from '../components/editor/ThemePicker';
import { canvasAt, describeElement, pickAt, pickTarget, tokensOnPage, type PickedToken } from './theme-eyedropper';
import { applyLiveOverride, clearLiveOverride, resolveHex } from './theme-live';
import './theme-editor.css';

/**
 * The theme editor, mounted over the real app in dev only.
 *
 * A "Themes" button opens a docked panel that leaves the page usable, so a
 * theme is edited while looking at the home page, the gallery, the editor or
 * Track. Escape closes it; a press on the page does not. Selecting a theme
 * makes it the app's theme, and every draft change is previewed at once by an
 * override rule on that theme's selector (see theme-live.ts). The override
 * lives as long as the draft, so closing the panel keeps it.
 *
 * Saving writes the theme file through /__themes/save. The override is left in
 * place after a save, because its values are now the file's: clearing it before
 * Vite hot-swaps the saved file in would flash the old colours. The next draft
 * change replaces it, and switching themes clears it.
 *
 * The Eyedropper button puts the page into pick mode: the next press on the
 * page is swallowed, the tokens the element under it paints with are listed
 * (see theme-eyedropper.ts) and highlighted, and the panel jumps to the main
 * one: the canvas chrome token over the chart's surroundings, else the
 * element's background, else its text. Escape leaves pick mode before it closes
 * the panel.
 *
 * Creating and deleting a theme also edit THEME_OPTIONS, which reloads the
 * page, so whether the panel is open and which theme it shows are kept in
 * sessionStorage and the editor comes back where it was.
 *
 * The server's registry is the source of theme ids, and it is ahead of the
 * bundled THEME_OPTIONS until that reload, so ids from it are passed to
 * setThemePreference as they are.
 */

interface ThemeToken {
  readonly name: string;
  readonly value: string;
}

interface ThemeGroup {
  readonly title: string;
  readonly tokens: readonly ThemeToken[];
}

interface Theme {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly file: string;
  readonly editable: { readonly duplicate: boolean; readonly delete: boolean };
  readonly selector: string;
  /** `null` when the file declares no color-scheme (needlewise). */
  readonly colorScheme: string | null;
  readonly groups: readonly ThemeGroup[];
}

/** Unsaved changes to one theme; `values` holds only the tokens that differ from the file. */
interface Draft {
  readonly label: string;
  readonly group: string;
  readonly colorScheme: string | null;
  readonly values: Readonly<Record<string, string>>;
}

interface NewTheme {
  readonly from: string;
  readonly id: string;
  readonly label: string;
  readonly group: string;
}

/**
 * Where the editor's toggle, panel and hover box are portalled: into the
 * topmost modal backdrop while a modal is open, else `<body>`. Inside the
 * backdrop they paint above the dialog and count as inside the modal, so a
 * press on the panel neither lands on the backdrop nor dismisses the modal.
 */
const portalHost = (): HTMLElement =>
  Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element.classList.contains('modal-backdrop')).at(-1) ?? document.body;

// The panel is non-modal: every press counts as inside it, so only Escape dismisses it.
const WHOLE_PAGE = { current: document.documentElement };

const OPEN_KEY = 'needlewise-theme-editor:open';
const SELECTED_KEY = 'needlewise-theme-editor:selected';
const DOCK_KEY = 'needlewise-theme-editor:dock';
const PAGE_KEY = 'needlewise-theme-editor:page';

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // The editor still works; it just forgets its place across a reload.
  }
}

/** GET without a body, POST with one; a 4xx `{ error }` becomes the thrown message. */
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${path} answered ${response.status}.`);
  return payload;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'The dev server could not be reached.';

const draftOf = (theme: Theme): Draft => ({ label: theme.label, group: theme.group, colorScheme: theme.colorScheme, values: {} });

const isDirty = (theme: Theme, draft: Draft): boolean =>
  draft.label !== theme.label
  || draft.group !== theme.group
  || draft.colorScheme !== theme.colorScheme
  || Object.keys(draft.values).length > 0;

/** Shows a draft on the page, or clears the preview when there is nothing to show. */
function preview(theme: Theme | null, draft: Draft | null): void {
  const declarations: Record<string, string> = { ...draft?.values };
  if (theme && draft?.colorScheme && draft.colorScheme !== theme.colorScheme) declarations['color-scheme'] = draft.colorScheme;
  if (theme && Object.keys(declarations).length > 0) applyLiveOverride(theme.selector, declarations);
  else clearLiveOverride();
}

export default function ThemeEditor() {
  const idPrefix = useId();
  const [open, setOpen] = useState(() => readSession(OPEN_KEY) === 'true');
  const [dock, setDock] = useState<'left' | 'right'>(() => (readSession(DOCK_KEY) === 'right' ? 'right' : 'left'));
  // On unless turned off this session.
  const [pageOnly, setPageOnly] = useState(() => readSession(PAGE_KEY) !== 'false');
  const [pageTokens, setPageTokens] = useState<ReadonlySet<string> | null>(null);
  const [themes, setThemes] = useState<readonly Theme[]>([]);
  const [selectedId, setSelectedId] = useState(() => readSession(SELECTED_KEY) ?? document.documentElement.dataset.theme ?? 'needlewise');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [resolved, setResolved] = useState('');
  const [creating, setCreating] = useState<NewTheme | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Theme | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ readonly element: string; readonly entries: readonly PickedToken[] } | null>(null);
  const [jump, setJump] = useState<{ readonly name: string } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState(portalHost);
  /** The panel's scroll offset and the index of its focused element, kept so a move to a new host can put them back. */
  const place = useRef({ scroll: 0, focus: -1 });
  const moved = useRef(false);

  const theme = themes.find((candidate) => candidate.id === selectedId) ?? null;
  const current = draft ?? (theme ? draftOf(theme) : null);
  const fileValues = useMemo(
    () => new Map(theme?.groups.flatMap((group) => group.tokens.map((token) => [token.name, token.value] as const))),
    [theme]
  );
  const defaults = useMemo(
    () => new Map(themes.find((candidate) => candidate.id === 'needlewise')?.groups.flatMap((group) => group.tokens.map((token) => [token.name, token.value] as const))),
    [themes]
  );
  const groupNames = [...new Set(themes.map((candidate) => candidate.group))];
  /** The selected theme's values with the draft applied, which the page filter follows references through. */
  const liveValues = useMemo(() => new Map([...fileValues, ...Object.entries(draft?.values ?? {})]), [fileValues, draft]);
  const onPage = pageOnly ? pageTokens : null;
  const pickedNames = new Set(picked?.entries.flatMap((entry) => (entry.target ? [entry.target] : [])));
  const rowId = (name: string) => `${idPrefix}-${name}-row`;

  async function load(preferredId: string) {
    try {
      const { themes: listed } = await request<{ themes: Theme[] }>('/__themes/themes');
      const id = listed.some((candidate) => candidate.id === preferredId) ? preferredId : 'needlewise';
      setThemes(listed);
      setSelectedId(id);
      writeSession(SELECTED_KEY, id);
      if (document.documentElement.dataset.theme !== id) setThemePreference(id as ThemeId);
    } catch (error) {
      setStatus(messageOf(error));
    }
  }

  useEffect(() => {
    void load(selectedId);
    return clearLiveOverride;
  }, []);

  /** Every draft change goes through here, so the page always shows the draft. */
  function changeDraft(next: Draft | null, token = activeToken) {
    const kept = theme && next && isDirty(theme, next) ? next : null;
    setDraft(kept);
    preview(theme, kept);
    if (token) setResolved(resolveHex(token));
  }

  function setValue(name: string, value: string) {
    if (!current) return;
    const values = { ...current.values };
    if (value === fileValues.get(name)) delete values[name];
    else values[name] = value;
    changeDraft({ ...current, values });
  }

  function resetValue(name: string) {
    if (!current) return;
    const values = { ...current.values };
    delete values[name];
    changeDraft({ ...current, values });
  }

  function setPageFilter(next: boolean) {
    setPageOnly(next);
    writeSession(PAGE_KEY, String(next));
  }

  // The page filter follows what is rendered: any change outside the editor, or to the stylesheets, recomputes it.
  useEffect(() => {
    if (!pageOnly) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recompute = () => setPageTokens(tokensOnPage(editorRef.current, liveValues, defaults));
    const schedule = (records: MutationRecord[]) => {
      if (records.every((record) => editorRef.current?.contains(record.target))) return;
      clearTimeout(timer);
      timer = setTimeout(recompute, 250);
    };
    recompute();
    const body = new MutationObserver(schedule);
    body.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] });
    const head = new MutationObserver(schedule);
    head.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => {
      clearTimeout(timer);
      body.disconnect();
      head.disconnect();
    };
  }, [pageOnly, liveValues, defaults]);

  function swapDock() {
    const next = dock === 'left' ? 'right' : 'left';
    setDock(next);
    writeSession(DOCK_KEY, next);
  }

  function setPanelOpen(next: boolean) {
    setOpen(next);
    writeSession(OPEN_KEY, String(next));
  }

  useDismissable({ open, refs: [WHOLE_PAGE], onDismiss: () => setPanelOpen(false), returnFocus: toggleRef });

  function show(id: string) {
    preview(null, null);
    setDraft(null);
    setActiveToken(null);
    setPicked(null);
    setThemePreference(id as ThemeId);
    // "System" is not a theme file: the preference stays "system" and the editor edits the theme it resolved to.
    const shown = id === 'system' ? document.documentElement.dataset.theme ?? 'needlewise' : id;
    setSelectedId(shown);
    writeSession(SELECTED_KEY, shown);
  }

  function select(id: string) {
    if (id === selectedId) return;
    if (draft) setPendingSelect(id);
    else show(id);
  }

  function openToken(name: string) {
    setActiveToken(name);
    setResolved(resolveHex(name));
  }

  /** Opens the panel on a token's row and its editor. */
  function jumpTo(name: string) {
    setPanelOpen(true);
    openToken(name);
    setJump({ name });
  }

  useEffect(() => {
    // rowId only reads the stable useId prefix.
    if (jump) document.getElementById(rowId(jump.name))?.scrollIntoView({ block: 'center' });
  }, [jump]);

  function applyPick(x: number, y: number) {
    const found = pickAt(x, y, editorRef.current, new Set(fileValues.keys()), defaults);
    if (!found) return;
    const { entries } = found;
    setPicked({ element: describeElement(found.element), entries });
    const rest = entries.filter((entry) => entry.state === 'rest');
    const main = rest.find((entry) => entry.category === 'canvas' && entry.target)
      ?? rest.find((entry) => entry.category === 'background' && entry.target)
      ?? rest.find((entry) => entry.category === 'text' && entry.target)
      ?? rest.find((entry) => entry.target)
      ?? entries.find((entry) => entry.target);
    if (main?.target) jumpTo(main.target);
  }
  // The pick listeners live as long as pick mode, so they read the latest theme through this ref.
  const applyPickRef = useRef(applyPick);
  applyPickRef.current = applyPick;

  // Escape leaves pick mode first: it registers above the panel on the shared stack.
  useDismissable({ open: picking, refs: [WHOLE_PAGE], onDismiss: () => setPicking(false) });

  // Follows modals opening, stacking and closing. Only the portalled subtree remounts; the editor's state lives here.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = portalHost();
      setHost((current) => {
        if (current !== next) moved.current = true;
        return next;
      });
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  // After a move, the panel scrolls back to where it was, and focus returns to the control it was on unless something else took it.
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const root = editorRef.current;
    const panel = root?.querySelector('.theme-editor');
    if (panel) panel.scrollTop = place.current.scroll;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!root || !lost || place.current.focus < 0) return;
    const control = root.querySelectorAll('*')[place.current.focus];
    if (control instanceof HTMLElement) control.focus();
    else if (panel instanceof HTMLElement) panel.focus();
  }, [host]);

  const rememberFocus = (event: React.FocusEvent) => {
    const root = editorRef.current;
    if (root) place.current.focus = Array.from(root.querySelectorAll('*')).indexOf(event.target);
  };
  const forgetFocus = (event: React.FocusEvent) => {
    // A focused node that is removed with its host has no related target, so it is still remembered.
    if (event.relatedTarget instanceof Node && !editorRef.current?.contains(event.relatedTarget)) place.current.focus = -1;
  };

  useEffect(() => {
    if (!picking) return undefined;
    const root = document.documentElement;
    const inEditor = (event: Event) => event.target instanceof Node && Boolean(editorRef.current?.contains(event.target));
    let pressed = false;
    // Window capture runs before the app and before dismiss.ts, so nothing else sees the pick press.
    const swallow = (event: Event) => {
      if (inEditor(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const hover = (event: PointerEvent) => {
      const target = inEditor(event) ? null : canvasAt(event.clientX, event.clientY, editorRef.current)?.canvas ?? pickTarget(event.clientX, event.clientY, editorRef.current);
      // Read on each move: the box is remounted when the editor moves into or out of a modal.
      const box = hoverRef.current;
      if (!box) return;
      box.hidden = !target;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      Object.assign(box.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const press = (event: PointerEvent) => {
      if (inEditor(event)) return;
      swallow(event);
      pressed = true;
      applyPickRef.current(event.clientX, event.clientY);
    };
    // The click follows pointerup in the same task, so pick mode ends only after it has been swallowed.
    const release = (event: PointerEvent) => {
      swallow(event);
      if (pressed) setTimeout(() => setPicking(false), 0);
    };
    const swallowed = ['mousedown', 'mouseup', 'click'] as const;
    root.classList.add('theme-editor-picking');
    window.addEventListener('pointermove', hover, true);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    for (const type of swallowed) window.addEventListener(type, swallow, true);
    return () => {
      root.classList.remove('theme-editor-picking');
      if (hoverRef.current) hoverRef.current.hidden = true;
      window.removeEventListener('pointermove', hover, true);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      for (const type of swallowed) window.removeEventListener(type, swallow, true);
    };
  }, [picking]);

  async function save() {
    if (!theme || !current) return;
    setBusy(true);
    setStatus('Saving…');
    try {
      const saved = await request<Theme>('/__themes/save', { id: theme.id, ...current });
      setThemes((listed) => listed.map((candidate) => (candidate.id === saved.id ? saved : candidate)));
      // The override is kept: it now matches the file, and clearing it before HMR lands would flash the old colours.
      setDraft(null);
      setStatus(`Saved ${saved.file}.`);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!creating) return;
    setBusy(true);
    setStatus('Creating…');
    try {
      const { id } = await request<{ id: string }>('/__themes/create', creating);
      setCreating(null);
      setDraft(null);
      clearLiveOverride();
      setActiveToken(null);
      setStatus(`Created ${id}.`);
      // Written before the reload the registry edit causes, so the page comes back on the new theme.
      writeSession(SELECTED_KEY, id);
      await load(id);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: Theme) {
    setPendingDelete(null);
    // The page must not be left on a theme whose stylesheet is gone.
    if (document.documentElement.dataset.theme === target.id || selectedId === target.id) show('needlewise');
    setBusy(true);
    setStatus(`Deleting ${target.label}…`);
    try {
      await request<{ id: string }>('/__themes/delete', { id: target.id });
      setStatus(`Deleted ${target.label}.`);
      await load(selectedId === target.id ? 'needlewise' : selectedId);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const duplicable = themes.filter((candidate) => candidate.editable.duplicate);
  const startCreating = (from: Theme) =>
    setCreating({ from: from.id, id: `${from.id}-copy`, label: `${from.label} copy`, group: from.group });

  return (
    <>
      {createPortal(
      <div ref={editorRef} className="theme-editor-root" onFocus={rememberFocus} onBlur={forgetFocus}>
      <button ref={toggleRef} className="theme-editor-toggle" data-dock={dock} type="button" aria-expanded={open} onClick={() => setPanelOpen(!open)}>Themes</button>
      {open && (
        <aside className="theme-editor" tabIndex={-1} onScroll={(event) => { place.current.scroll = event.currentTarget.scrollTop; }} data-dock={dock} aria-label="Theme editor">
          <header className="theme-editor-header">
            <h2>Themes</h2>
            <button type="button" aria-label={dock === 'left' ? 'Dock right' : 'Dock left'} onClick={swapDock}>{dock === 'left' ? '→' : '←'}</button>
            <button type="button" disabled={!theme} aria-label="Eyedropper" aria-pressed={picking} onClick={() => setPicking(!picking)}>{picking ? 'Picking…' : 'Eyedropper'}</button>
            <button type="button" disabled={busy || duplicable.length === 0} onClick={() => startCreating(theme && theme.editable.duplicate ? theme : duplicable[0])}>New theme</button>
          </header>
          <p className="theme-editor-status" role="status">{status}</p>

          {picked && (
            <section className="theme-editor-picked" aria-label={`Tokens on ${picked.element}`}>
              <h3>{picked.element}</h3>
              {picked.entries.length === 0 ? <p>No colour tokens apply here.</p> : (
                <ul>
                  {picked.entries.map((entry, index) => {
                    const target = entry.target;
                    const label = (
                      <>
                        <span className="theme-editor-picked-category">{entry.category}{entry.state === 'hover' && ' (hover)'}{entry.source && ` (from ${entry.source})`}</span>
                        <span className="theme-editor-name">{entry.chain.join(' → ')}</span>
                      </>
                    );
                    return (
                      <li key={index}>
                        {target
                          ? <button type="button" onClick={() => jumpTo(target)}>{label}</button>
                          : <span>{label}<span className="theme-editor-picked-category">inherited from Needlewise</span></span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          <div className="theme-field">
            <span id="theme-label">Theme</span>
            <ThemePicker value={selectedId as ThemeId} onChange={select} />
          </div>
          {theme && (theme.editable.duplicate || theme.editable.delete) && (
            <div className="theme-editor-actions">
              {theme.editable.duplicate && <button type="button" disabled={busy} aria-label={`Duplicate ${theme.label}`} onClick={() => startCreating(theme)}>Duplicate</button>}
              {theme.editable.delete && <button type="button" disabled={busy} aria-label={`Delete ${theme.label}`} onClick={() => setPendingDelete(theme)}>Delete</button>}
            </div>
          )}

          {creating && (
            <form className="theme-editor-create" aria-label="New theme" onSubmit={(event) => void create(event)}>
              <label>
                From
                <select value={creating.from} onChange={(event) => setCreating({ ...creating, from: event.target.value })}>
                  {duplicable.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                </select>
              </label>
              <label>
                Id
                <input type="text" value={creating.id} required autoComplete="off" onChange={(event) => setCreating({ ...creating, id: event.target.value })} />
              </label>
              <label>
                Label
                <input type="text" value={creating.label} required autoComplete="off" onChange={(event) => setCreating({ ...creating, label: event.target.value })} />
              </label>
              <label>
                Group
                <input type="text" value={creating.group} required autoComplete="off" list={`${idPrefix}-groups`} onChange={(event) => setCreating({ ...creating, group: event.target.value })} />
              </label>
              <datalist id={`${idPrefix}-groups`}>
                {groupNames.map((name) => <option key={name} value={name} />)}
              </datalist>
              <div className="theme-editor-actions">
                <button type="submit" disabled={busy}>Create</button>
                <button type="button" onClick={() => setCreating(null)}>Cancel</button>
              </div>
            </form>
          )}

          {theme && current && (
            <section className="theme-editor-detail" aria-label={`Edit ${theme.label}`}>
              <div className="theme-editor-meta">
                <label>
                  Label
                  <input type="text" value={current.label} autoComplete="off" onChange={(event) => changeDraft({ ...current, label: event.target.value })} />
                </label>
                <label>
                  Group
                  <input type="text" value={current.group} autoComplete="off" list={`${idPrefix}-groups`} onChange={(event) => changeDraft({ ...current, group: event.target.value })} />
                </label>
                {current.colorScheme !== null && (
                  <label>
                    Color scheme
                    <select value={current.colorScheme} onChange={(event) => changeDraft({ ...current, colorScheme: event.target.value })}>
                      <option value="light">light</option>
                      <option value="dark">dark</option>
                    </select>
                  </label>
                )}
              </div>
              <div className="theme-editor-actions">
                <button type="button" disabled={busy || !draft} onClick={() => void save()}>Save</button>
                <button type="button" disabled={busy || !draft} onClick={() => changeDraft(null)}>Discard</button>
                <span className="theme-editor-file">{theme.file}</span>
              </div>

              <label className="theme-editor-check">
                <input type="checkbox" checked={pageOnly} onChange={(event) => setPageFilter(event.target.checked)} />
                This page
              </label>
              {onPage && <p className="theme-editor-note">May list a few extra colours, but never hides one this page uses.</p>}
              {onPage?.size === 0 && <p>No theme colours found on this page.</p>}

              {theme.groups.map((group) => {
                // An edited, picked or open row stays, so a draft never disappears from under the user.
                const tokens = onPage
                  ? group.tokens.filter((token) => onPage.has(token.name) || token.name in current.values || pickedNames.has(token.name) || activeToken === token.name)
                  : group.tokens;
                if (tokens.length === 0) return null;
                return (
                  <section key={group.title} className="theme-editor-group">
                    <h3>{group.title}{onPage && ` (${tokens.length} of ${group.tokens.length})`}</h3>
                    <ul>
                      {tokens.map((token) => {
                        const value = current.values[token.name] ?? token.value;
                        const edited = token.name in current.values;
                        const editorId = `${idPrefix}-${token.name}`;
                        return (
                          <li key={token.name} id={rowId(token.name)} className={[edited ? 'is-edited' : '', pickedNames.has(token.name) ? 'is-picked' : ''].filter(Boolean).join(' ') || undefined}>
                            <div className="theme-editor-token">
                              <button type="button" aria-expanded={activeToken === token.name} onClick={() => (activeToken === token.name ? setActiveToken(null) : openToken(token.name))}>
                                <span className="theme-editor-swatch" style={{ background: `var(${token.name})` }} aria-hidden="true" />
                                <span className="theme-editor-name">{token.name}</span>
                                <span className="theme-editor-value">{value}</span>
                                {edited && <span className="theme-editor-edited">edited</span>}
                              </button>
                              {edited && <button type="button" aria-label={`Reset ${token.name}`} onClick={() => resetValue(token.name)}>Reset</button>}
                            </div>
                            {activeToken === token.name && (
                              <div className="theme-editor-token-editor">
                                <ColorField
                                  id={`${editorId}-hex`}
                                  value={resolved}
                                  onChange={(color) => { if (color) setValue(token.name, color); }}
                                  pickerLabel="Colour"
                                  textLabel="Hex"
                                  placeholder="#RRGGBB"
                                />
                                <label htmlFor={`${editorId}-value`}>Value</label>
                                <input id={`${editorId}-value`} type="text" value={value} autoComplete="off" spellCheck={false} onChange={(event) => setValue(token.name, event.target.value)} />
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </section>
          )}
        </aside>
      )}
      <div ref={hoverRef} className="theme-editor-hover" hidden aria-hidden="true" />
      </div>,
      host
      )}
      {pendingSelect && theme && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={`${theme.label} has changes that are not saved. Switching themes drops them.`}
          confirmLabel="Discard"
          onConfirm={() => { const id = pendingSelect; setPendingSelect(null); show(id); }}
          onCancel={() => setPendingSelect(null)}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.label}?`}
          message={`This deletes ${pendingDelete.file} and its entry in THEME_OPTIONS.`}
          confirmLabel="Delete"
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
