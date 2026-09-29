export type SearchRoot = Document | ShadowRoot;

/** Return the document and every open shadow root reachable from it. */
export function collectOpenRoots(root: Document = document): SearchRoot[] {
  const roots: SearchRoot[] = [root];
  const pending: SearchRoot[] = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      break;
    }
    current.querySelectorAll("*").forEach((element) => {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow && !roots.includes(shadow)) {
        roots.push(shadow);
        pending.push(shadow);
      }
    });
  }
  return roots;
}

export function queryAllOpenRoots<T extends Element>(
  selector: string,
  root: Document = document,
): T[] {
  return collectOpenRoots(root).flatMap((current) =>
    Array.from(current.querySelectorAll<T>(selector)),
  );
}
