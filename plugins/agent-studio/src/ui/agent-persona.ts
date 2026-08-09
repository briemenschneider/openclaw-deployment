import { LitElement, html, nothing, type TemplateResult } from "lit";
import {
  PERSONA_FILES,
  type PersonaEditorState,
  type PersonaResolution,
  type PersonaState,
} from "./persona-state.js";

const IDLE_STATE: PersonaState = {
  status: "idle",
  files: [],
  canSave: false,
  expired: false,
};

export class AgentPersona extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  state: PersonaState = IDLE_STATE;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected render(): TemplateResult {
    const { status, errorText, file } = this.state;
    return html`
      <section class="persona" aria-label="Persona files">
        ${status === "error"
          ? html`<p class="persona-error" role="alert">${errorText}</p>`
          : nothing}
        ${status !== "error" ? this.renderTabs() : nothing}
        ${this.state.expired
          ? html`<p class="persona-notice" data-state="expired" role="status">
              Connection expired. Reconnect to continue editing; unsaved text is kept here.
            </p>`
          : nothing}
        ${!this.state.canSave && status !== "error"
          ? html`<p class="persona-notice" data-state="read-only" role="status">
              This Gateway does not advertise agent file writes, so the editor is read-only.
            </p>`
          : nothing}
        ${file ? this.renderFile(file) : nothing}
      </section>
    `;
  }

  private renderTabs(): TemplateResult {
    const entries = this.state.files.length
      ? this.state.files
      : PERSONA_FILES.map((name) => ({ name, missing: true }));
    return html`
      <div class="persona-tabs" role="tablist" aria-label="Core files">
        ${entries.map(
          (entry) => html`
            <button
              class="persona-tab"
              type="button"
              role="tab"
              data-file=${entry.name}
              aria-selected=${this.state.selected === entry.name ? "true" : "false"}
              tabindex=${this.state.selected === entry.name ? 0 : -1}
              @click=${() => this.emit("persona-select", { name: entry.name })}
            >
              ${entry.name}${entry.missing
                ? html`<span class="tab-flag" title="Not created yet">·</span>`
                : nothing}
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderFile(file: PersonaEditorState): TemplateResult {
    if (file.status === "loading") {
      return html`<p class="persona-notice" data-state="loading" role="status">
        Loading ${file.name}…
      </p>`;
    }

    const showCreate = file.missing && !file.creating;
    return html`
      ${file.errorText
        ? html`<p class="persona-error" role="alert">${file.errorText}</p>`
        : nothing}
      ${file.saved && !file.dirty
        ? html`<p class="persona-notice" data-state="saved" role="status">Saved ${file.name}.</p>`
        : nothing}
      ${file.dirty
        ? html`<p class="persona-notice" data-state="dirty" role="status">
            Unsaved changes in ${file.name}.
          </p>`
        : nothing}
      ${showCreate
        ? html`
            <div class="persona-missing" data-state="missing">
              <p>${file.name} does not exist yet for this agent.</p>
              <button
                class="persona-create"
                type="button"
                ?disabled=${!this.state.canSave || this.state.expired}
                @click=${() => this.emit("persona-create", {})}
              >
                Create file
              </button>
            </div>
          `
        : html`
            <label class="visually-hidden" for="persona-editor">${file.name}</label>
            <textarea
              id="persona-editor"
              class="persona-editor"
              spellcheck="false"
              .value=${file.draft}
              ?disabled=${this.state.expired || file.conflict !== undefined}
              ?readonly=${!this.state.canSave}
              @input=${this.handleInput}
            ></textarea>
            ${this.state.canSave ? this.renderActions(file) : nothing}
          `}
      ${file.conflict ? this.renderConflict(file) : nothing}
    `;
  }

  private renderActions(file: PersonaEditorState): TemplateResult {
    const locked = this.state.expired || file.saving || file.conflict !== undefined;
    return html`
      <div class="persona-actions">
        <button
          class="persona-save primary-action"
          type="button"
          ?disabled=${!file.dirty || locked}
          @click=${() => this.emit("persona-save", {})}
        >
          ${file.saving ? "Saving" : "Save"}
        </button>
        <button
          class="persona-cancel quiet-action"
          type="button"
          ?disabled=${!file.dirty || locked}
          @click=${() => this.emit("persona-cancel", {})}
        >
          Discard changes
        </button>
      </div>
    `;
  }

  private renderConflict(file: PersonaEditorState): TemplateResult {
    const conflict = file.conflict;
    if (!conflict) return html``;
    return html`
      <div class="persona-conflict" role="alertdialog" aria-label=${`Conflict in ${file.name}`}>
        <p class="conflict-lede">
          ${file.name} changed on the server while you were editing. Choose which version to keep.
        </p>
        <div class="conflict-versions">
          <div>
            <h4>On the server</h4>
            <pre class="conflict-server">${conflict.server}</pre>
          </div>
          <div>
            <h4>Your version</h4>
            <pre class="conflict-local">${conflict.local}</pre>
          </div>
        </div>
        <div class="persona-actions">
          <button
            class="conflict-keep primary-action"
            type="button"
            @click=${() => this.emitResolution("keep-mine")}
          >
            Overwrite with mine
          </button>
          <button
            class="conflict-discard quiet-action"
            type="button"
            @click=${() => this.emitResolution("use-server")}
          >
            Use the server version
          </button>
        </div>
      </div>
    `;
  }

  private readonly handleInput = (event: Event): void => {
    const editor = event.target as HTMLTextAreaElement;
    this.emit("persona-input", { text: editor.value });
  };

  private emitResolution(choice: PersonaResolution): void {
    this.emit("persona-resolve", { choice });
  }

  private emit(type: string, detail: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

if (!customElements.get("agent-persona")) {
  customElements.define("agent-persona", AgentPersona);
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-persona": AgentPersona;
  }
}
