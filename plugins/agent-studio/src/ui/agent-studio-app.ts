import { LitElement, html, type TemplateResult } from "lit";
import {
  createAgentStudioApiClient,
  type AgentStudioApi,
  type AgentStudioFeatures,
  type DisconnectOptions,
} from "./api-client.js";

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

  connectedCallback(): void {
    super.connectedCallback();
    this.mounted = true;
    this.lifecycleGeneration += 1;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
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
                    autocomplete="current-password"
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
              <span class="count-readout" aria-label="No agents loaded">—</span>
            </div>
            <div class="directory-placeholder" role="status">
              <span class="placeholder-glyph" aria-hidden="true">⌁</span>
              <strong>Agent data arrives in the next stage</strong>
              <span>The directory will load here after the agent surface is enabled.</span>
            </div>
          </aside>

          <main id="agent-workspace" class="agent-workspace" aria-label="Agent workspace">
            <div class="workspace-header" aria-hidden="true">
              <span class="workspace-kicker">Workspace / no selection</span>
              <span class="header-rule"></span>
            </div>
            <section class="workspace-placeholder" aria-labelledby="workspace-empty-title">
              <div class="radar-mark" aria-hidden="true"><span></span></div>
              <p class="eyebrow">Standing by</p>
              <h1 id="workspace-empty-title">Select an agent to begin</h1>
              <p>
                Agent overview, persona controls, and session tools will occupy this workspace.
              </p>
            </section>
          </main>
        </div>
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

  private isCurrentLifecycle(generation: number): boolean {
    return this.mounted && generation === this.lifecycleGeneration;
  }

  private clearLocalConnection(): void {
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
