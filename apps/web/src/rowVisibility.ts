/**
 * One IntersectionObserver shared by all rows of a list. Each row registers
 * a callback that fires once, the first time the row comes within
 * `ROW_MARGIN` of the visible part of the scroll container.
 */
const ROW_MARGIN = "200px 0px";

export class RowVisibility {
  private observer: IntersectionObserver | null = null;
  private callbacks = new Map<Element, () => void>();

  /** Start observing within `root` (the list's scroll container). */
  attach(root: Element | null) {
    this.detach();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = this.callbacks.get(entry.target);
          this.unobserve(entry.target);
          callback?.();
        }
      },
      { root, rootMargin: ROW_MARGIN },
    );
    for (const el of this.callbacks.keys()) this.observer.observe(el);
  }

  detach() {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Call `onSeen` once when `el` is near the screen; returns a cleanup. */
  observe(el: Element, onSeen: () => void) {
    this.callbacks.set(el, onSeen);
    this.observer?.observe(el);
    return () => this.unobserve(el);
  }

  private unobserve(el: Element) {
    this.callbacks.delete(el);
    this.observer?.unobserve(el);
  }
}
