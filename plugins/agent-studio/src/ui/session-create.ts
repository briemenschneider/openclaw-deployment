import { LitElement, html, nothing, type TemplateResult } from "lit";
import type { AgentStudioApi, AgentStudioFeatures } from "./api-client.js";

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LABEL = 256;
const MAX_MODEL = 256;
const MAX_TASK = 32_768;

const CREATE_UNAVAILABLE = "This Gateway does not expose session creation.";
const CREATE_FAILED = "Could not create the session. Check the fields and try again.";
const NO_AGENT = "Select an agent before creating a session.";

export type SessionOptions = {
  label?: string;
  model?: string;
  task?: string;
  worktree?: boolean;
};

export type SessionCreateState = {
  status: "idle" | "creating" | "created" | "error";
  advancedOpen: boolean;
  agentId?: string;
  key?: string;
  errorText?: string;
};

export type SessionController = {
  getState(): SessionCreateState;
  subscribe(listener: (state: SessionCreateState) => void): () => void;
  create(agentId: string, options: SessionOptions): Promise<void>;
  setAdvancedOpen(open: boolean): void;
  reset(): void;
};

export type SessionControllerOptions = {
  api: Pick<AgentStudioApi, "operation">;
  connectionId: string;
  features: AgentStudioFeatures;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

type Validation =
  | { ok: true; payload: Record<string, unknown>; label?: string }
  | { ok: false; errorText: string };

function validate(agentId: string, options: SessionOptions): Validation {
  if (!AGENT_ID_PATTERN.test(agentId)) return { ok: false, errorText: NO_AGENT };

  const label = trimmed(options.label);
  const model = trimmed(options.model);
  const task = trimmed(options.task);
  if (label && label.length > MAX_LABEL) {
    return { ok: false, errorText: "Label must be 256 characters or fewer." };
  }
  if (model && model.length > MAX_MODEL) {
    return { ok: false, errorText: "Model must be 256 characters or fewer." };
  }
  if (task && task.length > MAX_TASK) {
    return { ok: false, errorText: "Task must be 32,768 characters or fewer." };
  }

  const payload: Record<string, unknown> = { agentId };
  if (label) payload.label = label;
  if (model) payload.model = model;
  if (task) payload.task = task;
  if (options.worktree) payload.worktree = true;
  return { ok: true, payload, label };
}

function sessionKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.key === "string" && value.key.length > 0 ? value.key : undefined;
}

export function createSessionController(options: SessionControllerOptions): SessionController {
  const { api, connectionId, features } = options;
  const listeners = new Set<(state: SessionCreateState) => void>();
  let state: SessionCreateState = { status: "idle", advancedOpen: false };

  function set(next: Partial<SessionCreateState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  }

  /**
   * A lost response may still have created a session. Look for it before letting the
   * operator retry, so a retry does not quietly produce a duplicate.
   */
  async function findCreated(agentId: string, label: string | undefined): Promise<string | undefined> {
    if (!label || !features.listSessions) return undefined;
    try {
      const response = await api.operation(connectionId, "listSessions", {
        agentId,
        limit: 20,
        includeGlobal: false,
      });
      if (!isRecord(response) || !Array.isArray(response.sessions)) return undefined;
      const match = response.sessions.find(
        (session) =>
          isRecord(session) && session.agentId === agentId && session.label === label,
      );
      return sessionKey(match);
    } catch {
      return undefined;
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setAdvancedOpen(open) {
      set({ advancedOpen: open, errorText: undefined });
    },

    reset() {
      set({ status: "idle", key: undefined, errorText: undefined, agentId: undefined });
    },

    async create(agentId, createOptions) {
      if (state.status === "creating") return;
      if (!features.createSession) {
        set({ status: "error", errorText: CREATE_UNAVAILABLE });
        return;
      }

      const validation = validate(agentId, createOptions);
      if (!validation.ok) {
        set({ status: "error", errorText: validation.errorText });
        return;
      }

      set({ status: "creating", errorText: undefined, key: undefined, agentId });

      let key: string | undefined;
      try {
        key = sessionKey(await api.operation(connectionId, "createSession", validation.payload));
      } catch {
        key = await findCreated(agentId, validation.label);
        if (!key) {
          set({ status: "error", errorText: CREATE_FAILED });
          return;
        }
      }

      set({ status: "created", key, advancedOpen: false, errorText: undefined });
    },
  };
}

export class SessionCreate extends LitElement {
  static properties = {
    agentId: { attribute: false },
    features: { attribute: false },
    state: { attribute: false },
    copied: { state: true },
    localAdvanced: { state: true },
  };

  agentId?: string;
  features?: AgentStudioFeatures;
  state: SessionCreateState = { status: "idle", advancedOpen: false };
  private copied = false;
  private localAdvanced = false;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("state") && this.state.status === "created") this.localAdvanced = false;
  }

  private get advancedOpen(): boolean {
    return this.localAdvanced || this.state.advancedOpen;
  }

  protected render(): TemplateResult {
    if (this.features?.createSession !== true) {
      return html`
        <section class="session-create" aria-label="Sessions">
          <p class="session-notice" data-state="unavailable" role="status">
            This Gateway does not expose session creation.
          </p>
        </section>
      `;
    }

    const busy = this.state.status === "creating";
    return html`
      <section class="session-create" aria-label="Sessions">
        <div class="session-actions">
          <button
            class="session-new primary-action"
            type="button"
            ?disabled=${busy || !this.agentId}
            @click=${() => this.emitCreate({})}
          >
            ${busy ? "Creating" : "New session"}
          </button>
          <button
            class="session-advanced quiet-action"
            type="button"
            aria-expanded=${this.advancedOpen ? "true" : "false"}
            @click=${() => this.emitAdvanced(!this.advancedOpen)}
          >
            Advanced
          </button>
        </div>
        ${this.state.errorText
          ? html`<p class="session-error" role="alert">${this.state.errorText}</p>`
          : nothing}
        ${this.advancedOpen ? this.renderDialog(busy) : nothing}
        ${this.state.status === "created" && this.state.key ? this.renderResult(this.state.key) : nothing}
      </section>
    `;
  }

  private renderDialog(busy: boolean): TemplateResult {
    return html`
      <div class="session-dialog" role="dialog" aria-label="Advanced session options">
        <label for="session-label">Label</label>
        <input id="session-label" type="text" maxlength="256" spellcheck="false" />
        <label for="session-model">Model override</label>
        <input id="session-model" type="text" maxlength="256" spellcheck="false" />
        <label for="session-task">Initial task</label>
        <textarea id="session-task" rows="4" spellcheck="false"></textarea>
        <label class="session-toggle" for="session-worktree">
          <input id="session-worktree" type="checkbox" />
          Run in a worktree
        </label>
        <div class="session-actions">
          <button
            class="session-submit primary-action"
            type="button"
            ?disabled=${busy || !this.agentId}
            @click=${this.submitAdvanced}
          >
            Create session
          </button>
          <button
            class="session-cancel quiet-action"
            type="button"
            @click=${() => this.emitAdvanced(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  private renderResult(key: string): TemplateResult {
    return html`
      <div class="session-result" role="status">
        <p>
          Created <code class="session-key">${key}</code>. Open it from OpenClaw's Sessions list.
        </p>
        <button class="session-copy quiet-action" type="button" @click=${() => this.copy(key)}>
          ${this.copied ? "Copied" : "Copy session key"}
        </button>
      </div>
    `;
  }

  private readonly submitAdvanced = (): void => {
    const label = this.querySelector<HTMLInputElement>("#session-label")?.value;
    const model = this.querySelector<HTMLInputElement>("#session-model")?.value;
    const task = this.querySelector<HTMLTextAreaElement>("#session-task")?.value;
    const worktree = this.querySelector<HTMLInputElement>("#session-worktree")?.checked === true;
    const options: SessionOptions = {};
    if (label?.trim()) options.label = label.trim();
    if (model?.trim()) options.model = model.trim();
    if (task?.trim()) options.task = task.trim();
    if (worktree) options.worktree = true;
    this.emitCreate(options);
  };

  private emitCreate(options: SessionOptions): void {
    if (!this.agentId) return;
    this.copied = false;
    this.dispatchEvent(
      new CustomEvent("session-create", {
        detail: { agentId: this.agentId, options },
        bubbles: true,
      }),
    );
  }

  private emitAdvanced(open: boolean): void {
    this.localAdvanced = open;
    this.dispatchEvent(new CustomEvent("session-advanced", { detail: { open }, bubbles: true }));
  }

  private async copy(key: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(key);
      this.copied = true;
    } catch {
      this.copied = false;
    }
  }
}

if (!customElements.get("session-create")) {
  customElements.define("session-create", SessionCreate);
}

declare global {
  interface HTMLElementTagNameMap {
    "session-create": SessionCreate;
  }
}
