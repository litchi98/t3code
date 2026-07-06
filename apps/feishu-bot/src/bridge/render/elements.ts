/**
 * CardKit 2.0 DSL element constructors (markdown / divider / collapsible).
 *
 * The base element-building layer of the v3 renderer (extracted from
 * `eventRenderer.ts`; M6, card render v3, M2b-4). Strictly pure: no IO. Every
 * render dimension composes cards out of these three primitives.
 */

// ── Element constructors (CardKit 2.0 DSL) ──────────────────────────────────

export interface MarkdownElement {
  readonly tag: "markdown";
  readonly content: string;
}

interface CollapsiblePanelElement {
  readonly tag: "collapsible_panel";
  readonly expanded: boolean;
  readonly header: {
    readonly title: { readonly tag: "markdown"; readonly content: string };
    readonly vertical_align: "center";
    readonly icon: {
      readonly tag: "standard_icon";
      readonly token: "down-small-ccm_outlined";
    };
    readonly icon_position: "right";
    readonly icon_expanded_angle: -180;
  };
  readonly elements: ReadonlyArray<MarkdownElement>;
}

interface DividerElement {
  readonly tag: "hr";
}

export const markdown = (content: string): MarkdownElement => ({ tag: "markdown", content });

export const divider = (): DividerElement => ({ tag: "hr" });

/**
 * Single-level collapsible panel: a header (`title` markdown + rotating angle
 * icon) over one markdown body. **Never put another collapsible_panel in the
 * body** — the outer panel serializes the inner content into the same element,
 * which both risks the 30KB per-element 400 bomb and is officially discouraged.
 * The activity history, plan, and changed-files panels each use this directly
 * with a multi-line markdown body for their inner rows.
 */
export const collapsible = (
  title: string,
  content: string,
  expanded: boolean,
): CollapsiblePanelElement => ({
  tag: "collapsible_panel",
  expanded,
  header: {
    title: { tag: "markdown", content: title },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
    icon_position: "right",
    icon_expanded_angle: -180,
  },
  elements: [markdown(content)],
});
