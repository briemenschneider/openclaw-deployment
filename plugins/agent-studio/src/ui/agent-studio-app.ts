import { LitElement, html, nothing, type TemplateResult } from "lit";
import {
  createAgentStudioApiClient,
  type AgentStudioApi,
  type AgentStudioFeatures,
  type DisconnectOptions,
} from "./api-client.js";
import {
  createAgentDirectoryStore,
  type AgentDirectoryState,
  type AgentDirectoryStore,
} from "./agent-state.js";
import {
  PERSONA_FILES,
  createPersonaStore,
  type PersonaResolution,
  type PersonaState,
  type PersonaStore,
} from "./persona-state.js";
import {
  createSessionController,
  type SessionController,
  type SessionCreateState,
  type SessionOptions,
} from "./session-create.js";
import "./agent-directory.js";
import "./agent-overview.js";
import "./agent-persona.js";
import "./session-create.js";

export type { AgentStudioApi } from "./api-client.js";

export class AgentStudioApp extends LitElement {
  static properties = {
    connectionId: { state: true },
    features: { state: true },
    connecting: { state: true },
    disconnecting: { state: true },
    drawerOpen: { state: true },
    statusText: { state: true },
    errorText: { state: true },
    directoryState: { state: true },
    personaState: { state: true },
    sessionState: { state: true },
    workspaceTab: { state: true },
  };

  api: AgentStudioApi = createAgentStudioApiClient();
  connectionId?: string;
  features?: AgentStudioFeatures;
  private connecting = false;
  private disconnecting = false;
  private drawerOpen = false;
  private statusText = "Gateway token required";
  private errorText = "";
  private mounted = false;
  private lifecycleGeneration = 0;
  private readonly disconnects = new Map<string, Promise<void>>();
  private directoryState?: AgentDirectoryState;
  private directory?: AgentDirectoryStore;
  private unsubscribeDirectory?: () => void;
  private workspaceTab: "overview" | "persona" = "overview";
  private personaState?: PersonaState;
  private persona?: PersonaStore;
  private unsubscribePersona?: () => void;
  private personaSyncing = false;
  private sessionState?: SessionCreateState;
  private sessions?: SessionController;
  private unsubscribeSessions?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.mounted = true;
    this.lifecycleGeneration += 1;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardown();
  }

  teardown(): void {
    if (!this.mounted && !this.connectionId && !this.connecting && !this.disconnecting) return;
    this.mounted = false;
    this.lifecycleGeneration += 1;
    const connectionId = this.connectionId;
    this.clearLocalConnection();
    const input = this.querySelector<HTMLInputElement>("#gateway-token");
    if (input) input.value = "";
    if (connectionId) {
      void this.disconnectConnection(connectionId, { keepalive: true });
    }
  }

  reactivate(): void {
    if (this.mounted || !this.isConnected) return;
    this.mounted = true;
    this.lifecycleGeneration += 1;
    this.clearLocalConnection();
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected render(): TemplateResult {
    return this.connectionId ? this.renderShell() : this.renderConnection();
  }

  private renderConnection(): TemplateResult {
    return html`
      <main class="connection-screen">
        <section class="connect-panel" aria-labelledby="connect-title">
          <div class="brand-lockup" aria-label="OpenClaw Agent Studio">
            <span class="brand-mark" aria-hidden="true">OC</span>
            <span>Agent Studio</span>
          </div>
          <div class="connect-grid">
            <div class="signal-rail signal-rail--auth" aria-hidden="true">
              <i></i><i></i><i></i><i></i><i></i>
            </div>
            <div class="connect-copy">
              <p class="eyebrow">Secure panel link</p>
              <h1 id="connect-title">Connect to your Gateway</h1>
              <p class="lede">
                Enter the local Gateway token to open this control room. It is used for this
                connection only and is cleared as soon as the request settles.
              </p>
              <div class="auth-controls" role="group" aria-labelledby="gateway-token-label">
                <label id="gateway-token-label" for="gateway-token">Gateway token</label>
                <div class="field-row">
                  <input
                    id="gateway-token"
                    name="gateway-token"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    ?disabled=${this.connecting}
                    @keydown=${this.handleTokenKeydown}
                    required
                    autofocus
                  />
                  <button
                    class="primary-action"
                    type="button"
                    ?disabled=${this.connecting}
                    @click=${this.handleConnect}
                  >
                    ${this.connecting ? html`<span class="activity" aria-hidden="true"></span>Connecting` : "Connect"}
                  </button>
                </div>
              </div>
              <p class="privacy-note">
                <span aria-hidden="true">◈</span>
                Never written to storage, URLs, logs, or panel state.
              </p>
              <p class="status-line" role="status" aria-live="polite">${this.statusText}</p>
              <p class="error-line" role="alert">${this.errorText}</p>
            </div>
          </div>
        </section>
      </main>
    `;
  }

  private renderShell(): TemplateResult {
    return html`
      <div class="studio-shell">
        <header class="studio-header">
          <button
            id="directory-toggle"
            class="icon-action drawer-toggle"
            type="button"
            aria-label="Toggle agent directory"
            aria-controls="agent-directory"
            aria-expanded=${String(this.drawerOpen)}
            @click=${() => {
              this.drawerOpen = !this.drawerOpen;
            }}
          >
            <span aria-hidden="true">☷</span>
          </button>
          <div class="brand-lockup brand-lockup--compact">
            <span class="brand-mark" aria-hidden="true">OC</span>
            <span>Agent Studio</span>
          </div>
          <div class="connection-state" role="status" aria-live="polite">
            <span class="connection-dot" aria-hidden="true"></span>
            Gateway connected
          </div>
          <button
            id="disconnect"
            class="quiet-action"
            type="button"
            ?disabled=${this.disconnecting}
            @click=${this.handleDisconnect}
          >
            ${this.disconnecting ? "Disconnecting" : "Disconnect"}
          </button>
        </header>

        <div class="studio-body">
          <button
            id="drawer-scrim"
            class="drawer-scrim"
            type="button"
            aria-label="Close agent directory"
            ?hidden=${!this.drawerOpen}
            @click=${() => {
              this.drawerOpen = false;
            }}
          ></button>
          <aside
            id="agent-directory"
            aria-label="Agent directory"
            ?data-open=${this.drawerOpen}
          >
            <div class="signal-rail signal-rail--directory" aria-hidden="true">
              <i></i><i></i><i></i><i></i><i></i><i></i>
            </div>
            <div class="directory-heading">
              <p class="eyebrow">Directory</p>
              <h2>Agents</h2>
              <span class="count-readout" aria-label=${this.agentCountLabel()}>
                ${this.directoryState?.status === "ready" ? this.directoryState.totalCount : "—"}
              </span>
            </div>
            ${this.directoryState
              ? html`<agent-directory
                  .state=${this.directoryState}
                  @agent-select=${this.handleAgentSelect}
                  @agent-query=${this.handleAgentQuery}
                  @agent-color=${this.handleAgentColor}
                ></agent-directory>`
              : nothing}
          </aside>

          <main id="agent-workspace" class="agent-workspace" aria-label="Agent workspace">
            <div class="workspace-header">
              <span class="workspace-kicker">
                Workspace / ${this.directoryState?.selectedAgent?.label ?? "no selection"}
              </span>
              <span class="header-rule"></span>
            </div>
            ${this.directoryState?.selectedAgent
              ? this.renderAgentWorkspace()
              : html`
                  <section class="workspace-placeholder" aria-labelledby="workspace-empty-title">
                    <div class="radar-mark" aria-hidden="true"><span></span></div>
                    <p class="eyebrow">Standing by</p>
                    <h1 id="workspace-empty-title">Select an agent to begin</h1>
                    <p>
                      Agent overview, persona controls, and session tools will occupy this
                      workspace.
                    </p>
                  </section>
                `}
          </main>
        </div>
      </div>
    `;
  }

  private renderAgentWorkspace(): TemplateResult {
    const agent = this.directoryState?.selectedAgent;
    return html`
      <div class="workspace-body">
        <session-create
          .agentId=${agent?.id}
          .features=${this.features}
          .state=${this.sessionState ?? { status: "idle", advancedOpen: false }}
          @session-create=${this.handleSessionCreate}
          @session-advanced=${this.handleSessionAdvanced}
        ></session-create>
        <div id="workspace-tabs" class="workspace-tabs" role="tablist" aria-label="Agent sections">
          ${(["overview", "persona"] as const).map(
            (tab) => html`
              <button
                class="workspace-tab"
                type="button"
                role="tab"
                data-tab=${tab}
                aria-selected=${this.workspaceTab === tab ? "true" : "false"}
                tabindex=${this.workspaceTab === tab ? 0 : -1}
                @click=${() => {
                  this.workspaceTab = tab;
                }}
              >
                ${tab === "overview" ? "Overview" : "Persona"}
              </button>
            `,
          )}
        </div>
        ${this.workspaceTab === "overview"
          ? html`<agent-overview
              .agent=${agent}
              .features=${this.features}
              .saving=${this.directoryState?.updatingAgentId === agent?.id}
              .errorText=${this.directoryState?.updateErrorText}
              @agent-update=${this.handleAgentUpdate}
            ></agent-overview>`
          : html`<agent-persona
              .state=${this.personaState ?? { status: "idle", files: [], canSave: false, expired: false }}
              @persona-select=${this.handlePersonaSelect}
              @persona-input=${this.handlePersonaInput}
              @persona-save=${this.handlePersonaSave}
              @persona-cancel=${this.handlePersonaCancel}
              @persona-create=${this.handlePersonaCreate}
              @persona-resolve=${this.handlePersonaResolve}
            ></agent-persona>`}
      </div>
    `;
  }

  private readonly handleTokenKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void this.handleConnect();
  };

  private readonly handleConnect = async (): Promise<void> => {
    if (this.connecting) return;
    const input = this.querySelector<HTMLInputElement>("#gateway-token");
    let token = input?.value ?? "";
    if (!token) return;
    const generation = this.lifecycleGeneration;

    this.connecting = true;
    this.errorText = "";
    this.statusText = "Connecting to Gateway";
    try {
      const result = await this.api.connect(token);
      if (!this.isCurrentLifecycle(generation)) {
        void this.disconnectConnection(result.connectionId, { keepalive: true });
        return;
      }
      this.connectionId = result.connectionId;
      this.features = result.features;
      this.statusText = "Gateway connected";
      this.startDirectory(result.connectionId, result.features);
    } catch {
      if (!this.isCurrentLifecycle(generation)) return;
      this.errorText = "Connection failed. Check the token and try again.";
      this.statusText = "Connection failed";
    } finally {
      if (input) input.value = "";
      token = "";
      if (!this.isCurrentLifecycle(generation)) return;
      this.connecting = false;
      this.requestUpdate();
      await this.updateComplete;
    }
  };

  private readonly handleDisconnect = async (): Promise<void> => {
    const connectionId = this.connectionId;
    if (!connectionId || this.disconnecting) return;
    const generation = this.lifecycleGeneration;
    this.disconnecting = true;
    try {
      await this.disconnectConnection(connectionId);
    } finally {
      if (!this.isCurrentLifecycle(generation)) return;
      this.clearLocalConnection();
      await this.updateComplete;
      this.querySelector<HTMLInputElement>("#gateway-token")?.focus();
    }
  };

  private agentCountLabel(): string {
    if (this.directoryState?.status !== "ready") return "No agents loaded";
    const count = this.directoryState.totalCount;
    return count === 1 ? "1 agent" : `${count} agents`;
  }

  private startDirectory(connectionId: string, features: AgentStudioFeatures): void {
    const generation = this.lifecycleGeneration;
    const store = createAgentDirectoryStore({ api: this.api, connectionId, features });
    this.directory = store;
    this.unsubscribeDirectory = store.subscribe((state) => {
      if (!this.isCurrentLifecycle(generation) || this.directory !== store) return;
      this.directoryState = state;
    });
    this.directoryState = store.getState();

    const persona = createPersonaStore({ api: this.api, connectionId, features });
    this.persona = persona;
    this.unsubscribePersona = persona.subscribe((state) => {
      if (!this.isCurrentLifecycle(generation) || this.persona !== persona) return;
      this.personaState = state;
    });

    const sessions = createSessionController({ api: this.api, connectionId, features });
    this.sessions = sessions;
    this.sessionState = sessions.getState();
    this.unsubscribeSessions = sessions.subscribe((state) => {
      if (!this.isCurrentLifecycle(generation) || this.sessions !== sessions) return;
      this.sessionState = state;
    });

    void store.load();
  }

  private stopDirectory(): void {
    this.unsubscribeSessions?.();
    this.unsubscribeSessions = undefined;
    this.sessions = undefined;
    this.sessionState = undefined;
    this.unsubscribeDirectory?.();
    this.unsubscribeDirectory = undefined;
    this.directory = undefined;
    this.directoryState = undefined;
    this.unsubscribePersona?.();
    this.unsubscribePersona = undefined;
    this.persona = undefined;
    this.personaState = undefined;
    this.workspaceTab = "overview";
  }

  protected updated(): void {
    this.syncPersona();
  }

  /** Loads persona files only once the operator actually opens the Persona tab. */
  private syncPersona(): void {
    const agentId = this.directoryState?.selectedId;
    const persona = this.persona;
    if (this.workspaceTab !== "persona" || !agentId || !persona || this.personaSyncing) return;

    if (this.personaState?.agentId !== agentId) {
      this.personaSyncing = true;
      void persona
        .selectAgent(agentId)
        .then(() => this.selectFirstPersonaFile())
        .finally(() => {
          this.personaSyncing = false;
        });
      return;
    }
    void this.selectFirstPersonaFile();
  }

  private async selectFirstPersonaFile(): Promise<void> {
    const state = this.persona?.getState();
    if (!this.persona || !state || state.status !== "ready" || state.selected) return;
    await this.persona.selectFile(PERSONA_FILES[0]);
  }

  private readonly handleAgentSelect = (event: Event): void => {
    const { agentId } = (event as CustomEvent<{ agentId: string }>).detail;
    this.directory?.select(agentId);
  };

  private readonly handleAgentQuery = (event: Event): void => {
    const { query } = (event as CustomEvent<{ query: string }>).detail;
    this.directory?.setQuery(query);
  };

  private readonly handleAgentColor = (event: Event): void => {
    const { agentId, color } = (event as CustomEvent<{ agentId: string; color: string }>).detail;
    void this.directory?.setColor(agentId, color);
  };

  private readonly handleAgentUpdate = (event: Event): void => {
    const { agentId, name, model } = (
      event as CustomEvent<{ agentId: string; name?: string; model?: string }>
    ).detail;
    void this.directory?.updateAgent(agentId, { name, model });
  };

  private readonly handleSessionCreate = (event: Event): void => {
    const { agentId, options } = (
      event as CustomEvent<{ agentId: string; options: SessionOptions }>
    ).detail;
    void this.sessions?.create(agentId, options);
  };

  private readonly handleSessionAdvanced = (event: Event): void => {
    const { open } = (event as CustomEvent<{ open: boolean }>).detail;
    this.sessions?.setAdvancedOpen(open);
  };

  private readonly handlePersonaSelect = (event: Event): void => {
    const { name } = (event as CustomEvent<{ name: string }>).detail;
    void this.persona?.selectFile(name);
  };

  private readonly handlePersonaInput = (event: Event): void => {
    const { text } = (event as CustomEvent<{ text: string }>).detail;
    this.persona?.setDraft(text);
  };

  private readonly handlePersonaSave = (): void => {
    void this.persona?.save();
  };

  private readonly handlePersonaCancel = (): void => {
    void this.persona?.cancel();
  };

  private readonly handlePersonaCreate = (): void => {
    this.persona?.createFile();
  };

  private readonly handlePersonaResolve = (event: Event): void => {
    const { choice } = (event as CustomEvent<{ choice: PersonaResolution }>).detail;
    void this.persona?.resolveConflict(choice);
  };

  private isCurrentLifecycle(generation: number): boolean {
    return this.mounted && generation === this.lifecycleGeneration;
  }

  private clearLocalConnection(): void {
    this.stopDirectory();
    this.connectionId = undefined;
    this.features = undefined;
    this.drawerOpen = false;
    this.connecting = false;
    this.disconnecting = false;
    this.errorText = "";
    this.statusText = "Disconnected. Gateway token required";
  }

  private disconnectConnection(
    connectionId: string,
    options?: DisconnectOptions,
  ): Promise<void> {
    const existing = this.disconnects.get(connectionId);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(() => options
        ? this.api.disconnect(connectionId, options)
        : this.api.disconnect(connectionId))
      .catch(() => undefined)
      .finally(() => {
        this.disconnects.delete(connectionId);
      });
    this.disconnects.set(connectionId, operation);
    return operation;
  }
}

if (!customElements.get("agent-studio-app")) {
  customElements.define("agent-studio-app", AgentStudioApp);
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-studio-app": AgentStudioApp;
  }
}
