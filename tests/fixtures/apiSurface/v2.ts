// Fixture for tests/apiSurface.test.ts — version 2 (renamed read → readInto) of a tiny public surface.
interface BodyOnly { readonly n: number }
class Impl<T> {
  private secret = 1;
  protected guarded(): void {}
  constructor(public readonly name: string, private readonly t: T) { void this.secret; void this.t; }
  readInto(out: T[]): number { const local: BodyOnly = { n: out.length }; return local.n; }
  /** @deprecated use read */
  legacy(): void {}
}
export type Handle<T> = Impl<T> & { readonly brand: "h" };
export const Handle = Impl;
export interface Options { readonly depth?: number; label: string }
export function make(opts: Options): Handle<number> { return new Impl(opts.label, 0) as Handle<number>; }
