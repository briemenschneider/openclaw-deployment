import { LitElement, html, nothing, type TemplateResult } from "lit";
import {
  AGENT_COLOR_NAMES,
  AGENT_COLOR_PALETTE,
  normalizeHexColor,
  type AgentDirectoryState,
  type DirectoryAgent,
} from "./agent-state.js";

const IDLE_STATE: AgentDirectoryState = {
  status: "idle",
  agents: [],
  totalCount: 0,
  query: "",
};

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

export class AgentDirectory extends LitElement {
  static properties = {
    state: { attribute: false },
    openColorAgentId: { state: true },
    customHexError: { state: true },
  };

  state: AgentDirectoryState = IDLE_STATE;
  private openColorAgentId?: string;
  private customHexError = false;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected render(): TemplateResult {
    const { status, agents, totalCount, query } = this.state;
    return html`
      <div class="agent-directory" @keydown=${this.handleKeydown}>
        <div class="directory-search">
          <input
            id="agent-search"
            class="search-field"
            type="search"
            aria-label="Search agents"
            placeholder="Search agents"
            .value=${query}
            ?disabled=${status === "error"}
            @input=${this.handleQueryInput}
          />
        </div>
        ${status === "error"
          ? html`<p class="directory-error" role="alert">${this.state.errorText}</p>`
          : nothing}
        ${status === "loading"
          ? html`<p class="directory-status" data-state="loading" role="status">Loading agents…</p>`
          : nothing}
        ${status === "ready" && totalCount === 0
          ? html`<p class="directory-status" data-state="empty" role="status">
              No agents available on this Gateway.
            </p>`
          : nothing}
        ${status === "ready" && totalCount > 0 && agents.length === 0
          ? html`<p class="directory-status" data-state="no-match" role="status">
              No agents match “${query}”.
            </p>`
          : nothing}
        ${agents.length > 0
          ? html`<ul id="agent-list" class="agent-list" aria-label="Agents">
              ${agents.map((agent, index) => this.renderAgent(agent, index))}
            </ul>`
          : nothing}
        ${this.state.colorErrorText
          ? html`<p class="directory-error" data-error="color" role="status">
              ${this.state.colorErrorText}
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderAgent(agent: DirectoryAgent, index: number): TemplateResult {
    const selected = agent.id === this.state.selectedId;
    const swatchStyle = agent.color ? `background-color: ${agent.color}` : "";
    return html`
      <li class="agent-row" data-agent-id=${agent.id}>
        <button
          class="agent-select"
          type="button"
          aria-current=${selected ? "true" : "false"}
          tabindex=${this.rovingTabIndex(index)}
          @click=${() => this.emitSelect(agent.id)}
        >
          <span
            class="agent-swatch"
            data-color=${agent.color ?? ""}
            style=${swatchStyle}
            aria-hidden="true"
          ></span>
          <span class="agent-identity">
            <span class="agent-label">${agent.emoji ? `${agent.emoji} ` : ""}${agent.label}</span>
            <span class="agent-meta">${agent.model ?? agent.id}</span>
          </span>
          ${selected
            ? html`<span class="selected-marker" aria-hidden="true">▍</span
                ><span class="visually-hidden">Selected</span>`
            : nothing}
        </button>
        <button
          class="color-trigger"
          type="button"
          aria-label=${`Set color for ${agent.label}`}
          aria-haspopup="dialog"
          aria-expanded=${this.openColorAgentId === agent.id ? "true" : "false"}
          @click=${() => this.toggleColorPicker(agent.id)}
        >
          <span aria-hidden="true">◍</span>
        </button>
        ${this.openColorAgentId === agent.id ? this.renderColorPicker(agent) : nothing}
      </li>
    `;
  }

  private renderColorPicker(agent: DirectoryAgent): TemplateResult {
    return html`
      <div
        class="color-popover"
        role="dialog"
        aria-label=${`Color for ${agent.label}`}
      >
        <div class="palette" role="group" aria-label="Palette">
          ${AGENT_COLOR_PALETTE.map(
            (color) => html`
              <button
                class="palette-swatch"
                type="button"
                data-color=${color}
                style=${`background-color: ${color}`}
                aria-label=${AGENT_COLOR_NAMES[color] ?? color}
                aria-pressed=${agent.color === color ? "true" : "false"}
                @click=${() => this.emitColor(agent.id, color)}
              ></button>
            `,
          )}
        </div>
        <div class="custom-color">
          <label class="visually-hidden" for="custom-hex">Custom color</label>
          <input
            id="custom-hex"
            class="custom-hex"
            type="text"
            inputmode="text"
            spellcheck="false"
            placeholder="#rrggbb"
            maxlength="7"
            @keydown=${this.handleCustomHexKeydown}
          />
          <button class="custom-apply" type="button" @click=${() => this.applyCustomHex(agent.id)}>
            Apply
          </button>
        </div>
        ${this.customHexError
          ? html`<p class="hex-error" data-error="hex" role="alert">Enter a color as #rrggbb.</p>`
          : nothing}
      </div>
    `;
  }

  private rovingTabIndex(index: number): number {
    const selectedIndex = this.state.agents.findIndex(
      (agent) => agent.id === this.state.selectedId,
    );
    const active = selectedIndex >= 0 ? selectedIndex : 0;
    return index === active ? 0 : -1;
  }

  private readonly handleQueryInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    this.dispatchEvent(
      new CustomEvent("agent-query", { detail: { query: input.value }, bubbles: true }),
    );
  };

  private readonly handleCustomHexKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (this.openColorAgentId) this.applyCustomHex(this.openColorAgentId);
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.openColorAgentId) {
      event.stopPropagation();
      this.closeColorPicker();
      return;
    }
    if (!NAVIGATION_KEYS.has(event.key)) return;
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("agent-select")) return;

    const buttons = [...this.querySelectorAll<HTMLButtonElement>(".agent-select")];
    const current = buttons.indexOf(target as HTMLButtonElement);
    if (current < 0) return;

    let next = current;
    if (event.key === "ArrowDown") next = Math.min(current + 1, buttons.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
    else if (event.key === "Home") next = 0;
    else next = buttons.length - 1;

    event.preventDefault();
    if (next === current) return;
    buttons[next].focus();
    const agentId = buttons[next].closest(".agent-row")?.getAttribute("data-agent-id");
    if (agentId) this.emitSelect(agentId);
  };

  private toggleColorPicker(agentId: string): void {
    this.openColorAgentId = this.openColorAgentId === agentId ? undefined : agentId;
    this.customHexError = false;
  }

  private closeColorPicker(): void {
    this.openColorAgentId = undefined;
    this.customHexError = false;
  }

  private applyCustomHex(agentId: string): void {
    const input = this.querySelector<HTMLInputElement>(".custom-hex");
    const color = normalizeHexColor(input?.value);
    if (!color) {
      this.customHexError = true;
      return;
    }
    this.emitColor(agentId, color);
  }

  private emitSelect(agentId: string): void {
    this.dispatchEvent(new CustomEvent("agent-select", { detail: { agentId }, bubbles: true }));
  }

  private emitColor(agentId: string, color: string): void {
    this.closeColorPicker();
    this.dispatchEvent(
      new CustomEvent("agent-color", { detail: { agentId, color }, bubbles: true }),
    );
  }
}

if (!customElements.get("agent-directory")) {
  customElements.define("agent-directory", AgentDirectory);
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-directory": AgentDirectory;
  }
}
