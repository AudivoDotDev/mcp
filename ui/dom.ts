/**
 * The only way the app puts anything on the page.
 *
 * Every title and transcript line is a publisher's or a recording's text,
 * delivered unfenced in `_meta` (ADR-0036 decision 2). So nothing here ever
 * parses markup: strings become text nodes, and attributes are set one by
 * one. `ui/dom.test.ts` holds the whole app to that.
 */

export type Child = Node | string | number | null | undefined | false;

export type Props = {
  readonly class?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly on?: Readonly<{
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  }>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class !== undefined) node.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(name, handler as EventListener);
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/**
 * `text` with every case-insensitive occurrence of `query` wrapped in a
 * `<mark>`: built from text nodes, so a query or a line full of markup is
 * only ever text.
 */
export function highlight(text: string, query: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  const haystack = text.toLocaleLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) fragment.appendChild(document.createTextNode(text.slice(from, at)));
    fragment.appendChild(el('mark', {}, text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  if (from < text.length) fragment.appendChild(document.createTextNode(text.slice(from)));
  return fragment;
}
