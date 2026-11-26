// ToolProjection — the single decision point that turns a completed agy tool
// step into a native `agy_tool` call.
//
// The event mapper used to take a `canCutOnTool` callback supplied by the span
// driver. That callback reached into the host's tools service while the mapper
// was streaming, which is the inference <-> mirror feedback edge in the
// coupling analysis (docs/architecture/coupling.md, kernel B).
//
// This object owns the capability instead:
//   * `cutOnTool` is the static purpose policy (main turn vs auxiliary call);
//   * the optional probe is a read-only liveness function for the rare cases
//     where the mirror can disappear mid-span (plugin disposal, tools.restrict,
//     tools service remount). The host injects it; the mapper never imports or
//     queries the tools service.
//
// `agy_tool` itself only reads the immutable RunRecording, so the remaining
// data flow is one-way: mapper writes recording -> mirror reads recording.
export interface ToolProjectionOptions {
  /** Cut spans on completed tool steps (main turns). False for auxiliary calls. */
  cutOnTool: boolean
  /**
   * Dynamic liveness check evaluated right before cutting a span. False means
   * the mirror is currently unregistered, hidden by an agent-scope restriction,
   * or the plugin is disposing.
   */
  canCutOnTool?: () => boolean
}

export class ToolProjection {
  private readonly cutOnTool: boolean
  private readonly canCutOnTool: (() => boolean) | undefined

  constructor(options: ToolProjectionOptions) {
    this.cutOnTool = options.cutOnTool
    this.canCutOnTool = options.canCutOnTool
  }

  /**
   * Whether the current completed tool step may become a native tool card.
   * False for auxiliary calls and whenever the mirror liveness probe says the
   * tool is unavailable right now.
   */
  get canCut(): boolean {
    if (!this.cutOnTool) return false
    return this.canCutOnTool === undefined ? true : this.canCutOnTool()
  }

  /** Static policy only; useful for tests and for the running-progress note. */
  get enabled(): boolean {
    return this.cutOnTool
  }
}
