/**
 * The least DOM that react-dom/client needs to mount a component, run its
 * effects and take clicks — so a page's states AFTER its reads can be tested
 * under node:test (renderToStaticMarkup runs no effect: it shows only the
 * first paint). Import it FIRST, before react-dom.
 */
class FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  style: Record<string, unknown> & { setProperty: (k: string, v: unknown) => void };
  nodeValue: string | null = null;
  ownerDocument: unknown;
  value = "";
  checked = false;
  type = "";
  [k: string]: unknown;

  constructor(nodeType: number, name: string, doc: unknown) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
    this.ownerDocument = doc;
    const style: Record<string, unknown> = {};
    Object.defineProperty(style, "setProperty", { enumerable: false, value: (k: string, v: unknown) => void (style[k] = v) });
    this.style = style as FakeNode["style"];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const s = this.parentNode?.childNodes;
    return s ? (s[s.indexOf(this) + 1] ?? null) : null;
  }
  appendChild(c: FakeNode) {
    c.parentNode?.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c: FakeNode, before: FakeNode | null) {
    c.parentNode?.removeChild(c);
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i < 0) this.childNodes.push(c);
    else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  contains(n: FakeNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  setAttribute(k: string, v: unknown) {
    this.attributes.set(k, String(v));
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attributes.has(k);
  }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  closest() {
    return null;
  }
  scrollIntoView() {}
  focus() {}
  blur() {}
  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3) {
      this.nodeValue = v;
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(new FakeNode(3, "#text", this.ownerDocument).withText(v));
  }
  withText(v: string) {
    this.nodeValue = v;
    return this;
  }
}

const doc: Record<string, unknown> = {
  nodeType: 9,
  nodeName: "#document",
  visibilityState: "visible",
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  createElement: (t: string) => new FakeNode(1, t, doc),
  createElementNS: (_ns: string, t: string) => new FakeNode(1, t, doc),
  createTextNode: (t: string) => new FakeNode(3, "#text", doc).withText(t),
  createComment: (t: string) => new FakeNode(8, "#comment", doc).withText(t),
};
doc.body = new FakeNode(1, "body", doc);
doc.documentElement = new FakeNode(1, "html", doc);
doc.defaultView = globalThis;

const g = globalThis as Record<string, unknown>;
g.document = doc;
g.window = globalThis;
g.HTMLIFrameElement = class {};
g.HTMLElement = FakeNode;
if (!g.addEventListener) {
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
}
if (!g.matchMedia) g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

export type El = FakeNode;
export const newContainer = (): El => new FakeNode(1, "div", doc);

/** Every element under `root` (depth first). */
export function all(root: El): El[] {
  const out: El[] = [];
  const walk = (n: El) => {
    if (n.nodeType === 1) out.push(n);
    n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

/** The props React keeps on a host node (onClick, onChange, disabled …). */
export function propsOf(n: El): Record<string, any> {
  const k = Object.keys(n).find((x) => x.startsWith("__reactProps$"));
  return k ? (n[k] as Record<string, any>) : {};
}

/** The <button>s whose text is exactly `text`, in document order. */
export function buttons(root: El, text: string): El[] {
  return all(root).filter((n) => n.nodeName === "BUTTON" && n.textContent.trim() === text);
}

/** The first of them. */
export function button(root: El, text: string): El | undefined {
  return buttons(root, text)[0];
}

/** Let promises, effects and React's scheduler run. */
export const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
