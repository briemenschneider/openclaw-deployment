import { LitElement, html, nothing, type TemplateResult } from "lit";
import type { DirectoryAgent } from "./agent-state.js";
import type { AgentStudioFeatures } from "./api-client.js";

export class AgentOverview extends LitElement {
  static properties = {
    agent: { attribute: false },
    features: { attribute: false },
    saving: { type: Boolean },
    errorText: { attribute: false },
    draftName: { state: true },
    draftModel: { state: true },
    localError: { state: true },
  };

  agent?: DirectoryAgent;
  features?: AgentStudioFeatures;
  saving = false;
  errorText?: string;
  private draftName?: string;
  private draftModel?: string;
  private localError = "";

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("agent")) return;
    const previous = changed.get("agent") as DirectoryAgent | undefined;
    if (previous?.id !== this.agent?.id) {
      this.draftName = undefined;
      this.draftModel = undefined;
      this.localError = "";
    }
  }

  protected render(): TemplateResult {
    const agent = this.agent;
    if (!agent) {
      return html`
        <section class="overview" aria-label="Agent overview">
          <p class="overview-empty" role="status">Select an agent to see its settings.</p>
        </section>
      `;
    }

    const editable = this.features?.updateAgent === true;
    return html`
      <section class="overview" aria-label="Agent overview">
        <h3 class="overview-title">${agent.emoji ? `${agent.emoji} ` : ""}${agent.label}</h3>
        <dl class="overview-facts">
          ${editable ? nothing : this.renderFact("name", "Name", agent.label)}
          ${this.renderFact("id", "Agent id", agent.id)}
          ${this.renderFact("model", "Model", agent.model ?? "Gateway default")}
          ${this.renderFact(
            "workspace",
            "Workspace",
            agent.workspaceGit === undefined
              ? "Not reported"
              : agent.workspaceGit
                ? "Git repository"
                : "Plain directory",
          )}
        </dl>
        ${this.errorText || this.localError
          ? html`<p class="overview-error" role="alert">${this.localError || this.errorText}</p>`
          : nothing}
        ${editable ? this.renderEditor(agent) : this.renderReadOnly()}
      </section>
    `;
  }

  private renderFact(key: string, term: string, value: string): TemplateResult {
    return html`
      <div class="overview-fact" data-fact=${key}>
        <dt>${term}</dt>
        <dd>${value}</dd>
      </div>
    `;
  }

  private renderEditor(agent: DirectoryAgent): TemplateResult {
    const name = this.draftName ?? agent.label;
    const model = this.draftModel ?? agent.model ?? "";
    const dirty = name !== agent.label || model !== (agent.model ?? "");
    return html`
      <div class="overview-editor">
        <label for="overview-name">Display name</label>
        <input
          id="overview-name"
          type="text"
          maxlength="128"
          spellcheck="false"
          .value=${name}
          ?disabled=${this.saving}
          @input=${(event: Event) => {
            this.draftName = (event.target as HTMLInputElement).value;
            this.localError = "";
          }}
        />
        <label for="overview-model">Primary model</label>
        <input
          id="overview-model"
          type="text"
          maxlength="256"
          spellcheck="false"
          placeholder="Gateway default"
          .value=${model}
          ?disabled=${this.saving}
          @input=${(event: Event) => {
            this.draftModel = (event.target as HTMLInputElement).value;
            this.localError = "";
          }}
        />
        <button
          class="overview-save primary-action"
          type="button"
          ?disabled=${!dirty || this.saving}
          @click=${() => this.submit(agent)}
        >
          ${this.saving ? "Saving" : "Save changes"}
        </button>
      </div>
    `;
  }

  private renderReadOnly(): TemplateResult {
    return html`
      <p class="overview-notice" data-state="read-only" role="status">
        This Gateway does not advertise agent updates. Change these settings from OpenClaw's
        built-in Agents page.
      </p>
    `;
  }

  private submit(agent: DirectoryAgent): void {
    const name = (this.draftName ?? agent.label).trim();
    const model = (this.draftModel ?? agent.model ?? "").trim();
    if (!name) {
      this.localError = "Name cannot be empty.";
      return;
    }

    const detail: Record<string, unknown> = { agentId: agent.id };
    if (name !== agent.label) detail.name = name;
    if (model && model !== (agent.model ?? "")) detail.model = model;
    if (Object.keys(detail).length < 2) return;

    this.localError = "";
    this.dispatchEvent(new CustomEvent("agent-update", { detail, bubbles: true }));
  }
}

if (!customElements.get("agent-overview")) {
  customElements.define("agent-overview", AgentOverview);
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-overview": AgentOverview;
  }
}
