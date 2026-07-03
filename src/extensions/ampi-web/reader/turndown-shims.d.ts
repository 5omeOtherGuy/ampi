/**
 * Minimal ambient declarations for `turndown` and `turndown-plugin-gfm`.
 *
 * `turndown` does not ship its own types; the official
 * `@types/turndown` package targets an older surface. We only use a
 * tiny slice of the API (`new TurndownService(opts)`, `use(plugin)`,
 * `turndown(html)`, `addRule(name, rule)`), so declaring that slice
 * locally keeps `ampi-web` independent of the DefinitelyTyped lag.
 */

declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    codeBlockStyle?: "indented" | "fenced";
    bulletListMarker?: "-" | "*" | "+";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
    hr?: string;
    linkStyle?: "inlined" | "referenced";
    [option: string]: unknown;
  }
  class TurndownService {
    constructor(options?: TurndownOptions);
    use(plugin: unknown): void;
    turndown(html: string): string;
    addRule(name: string, rule: unknown): void;
  }
  export default TurndownService;
}

declare module "turndown-plugin-gfm" {
  export const gfm: unknown;
  export const tables: unknown;
  export const strikethrough: unknown;
  export const taskListItems: unknown;
}
