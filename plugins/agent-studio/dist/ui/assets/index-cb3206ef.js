(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) return;
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) processPreload(link);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
    }
  }).observe(document, {
    childList: true,
    subtree: true
  });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep) return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
const t$1 = globalThis, e$2 = t$1.ShadowRoot && (void 0 === t$1.ShadyCSS || t$1.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, s$2 = /* @__PURE__ */ Symbol(), o$3 = /* @__PURE__ */ new WeakMap();
let n$2 = class n {
  constructor(t2, e2, o2) {
    if (this._$cssResult$ = true, o2 !== s$2) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = t2, this.t = e2;
  }
  get styleSheet() {
    let t2 = this.o;
    const s2 = this.t;
    if (e$2 && void 0 === t2) {
      const e2 = void 0 !== s2 && 1 === s2.length;
      e2 && (t2 = o$3.get(s2)), void 0 === t2 && ((this.o = t2 = new CSSStyleSheet()).replaceSync(this.cssText), e2 && o$3.set(s2, t2));
    }
    return t2;
  }
  toString() {
    return this.cssText;
  }
};
const r$2 = (t2) => new n$2("string" == typeof t2 ? t2 : t2 + "", void 0, s$2), S$1 = (s2, o2) => {
  if (e$2) s2.adoptedStyleSheets = o2.map((t2) => t2 instanceof CSSStyleSheet ? t2 : t2.styleSheet);
  else for (const e2 of o2) {
    const o3 = document.createElement("style"), n3 = t$1.litNonce;
    void 0 !== n3 && o3.setAttribute("nonce", n3), o3.textContent = e2.cssText, s2.appendChild(o3);
  }
}, c$2 = e$2 ? (t2) => t2 : (t2) => t2 instanceof CSSStyleSheet ? ((t3) => {
  let e2 = "";
  for (const s2 of t3.cssRules) e2 += s2.cssText;
  return r$2(e2);
})(t2) : t2;
const { is: i$2, defineProperty: e$1, getOwnPropertyDescriptor: h$1, getOwnPropertyNames: r$1, getOwnPropertySymbols: o$2, getPrototypeOf: n$1 } = Object, a$1 = globalThis, c$1 = a$1.trustedTypes, l$1 = c$1 ? c$1.emptyScript : "", p$1 = a$1.reactiveElementPolyfillSupport, d$1 = (t2, s2) => t2, u$1 = { toAttribute(t2, s2) {
  switch (s2) {
    case Boolean:
      t2 = t2 ? l$1 : null;
      break;
    case Object:
    case Array:
      t2 = null == t2 ? t2 : JSON.stringify(t2);
  }
  return t2;
}, fromAttribute(t2, s2) {
  let i2 = t2;
  switch (s2) {
    case Boolean:
      i2 = null !== t2;
      break;
    case Number:
      i2 = null === t2 ? null : Number(t2);
      break;
    case Object:
    case Array:
      try {
        i2 = JSON.parse(t2);
      } catch (t3) {
        i2 = null;
      }
  }
  return i2;
} }, f$1 = (t2, s2) => !i$2(t2, s2), b$1 = { attribute: true, type: String, converter: u$1, reflect: false, useDefault: false, hasChanged: f$1 };
Symbol.metadata ??= /* @__PURE__ */ Symbol("metadata"), a$1.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
let y$1 = class y extends HTMLElement {
  static addInitializer(t2) {
    this._$Ei(), (this.l ??= []).push(t2);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(t2, s2 = b$1) {
    if (s2.state && (s2.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t2) && ((s2 = Object.create(s2)).wrapped = true), this.elementProperties.set(t2, s2), !s2.noAccessor) {
      const i2 = /* @__PURE__ */ Symbol(), h2 = this.getPropertyDescriptor(t2, i2, s2);
      void 0 !== h2 && e$1(this.prototype, t2, h2);
    }
  }
  static getPropertyDescriptor(t2, s2, i2) {
    const { get: e2, set: r2 } = h$1(this.prototype, t2) ?? { get() {
      return this[s2];
    }, set(t3) {
      this[s2] = t3;
    } };
    return { get: e2, set(s3) {
      const h2 = e2?.call(this);
      r2?.call(this, s3), this.requestUpdate(t2, h2, i2);
    }, configurable: true, enumerable: true };
  }
  static getPropertyOptions(t2) {
    return this.elementProperties.get(t2) ?? b$1;
  }
  static _$Ei() {
    if (this.hasOwnProperty(d$1("elementProperties"))) return;
    const t2 = n$1(this);
    t2.finalize(), void 0 !== t2.l && (this.l = [...t2.l]), this.elementProperties = new Map(t2.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(d$1("finalized"))) return;
    if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d$1("properties"))) {
      const t3 = this.properties, s2 = [...r$1(t3), ...o$2(t3)];
      for (const i2 of s2) this.createProperty(i2, t3[i2]);
    }
    const t2 = this[Symbol.metadata];
    if (null !== t2) {
      const s2 = litPropertyMetadata.get(t2);
      if (void 0 !== s2) for (const [t3, i2] of s2) this.elementProperties.set(t3, i2);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t3, s2] of this.elementProperties) {
      const i2 = this._$Eu(t3, s2);
      void 0 !== i2 && this._$Eh.set(i2, t3);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(s2) {
    const i2 = [];
    if (Array.isArray(s2)) {
      const e2 = new Set(s2.flat(1 / 0).reverse());
      for (const s3 of e2) i2.unshift(c$2(s3));
    } else void 0 !== s2 && i2.push(c$2(s2));
    return i2;
  }
  static _$Eu(t2, s2) {
    const i2 = s2.attribute;
    return false === i2 ? void 0 : "string" == typeof i2 ? i2 : "string" == typeof t2 ? t2.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    this._$ES = new Promise((t2) => this.enableUpdating = t2), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t2) => t2(this));
  }
  addController(t2) {
    (this._$EO ??= /* @__PURE__ */ new Set()).add(t2), void 0 !== this.renderRoot && this.isConnected && t2.hostConnected?.();
  }
  removeController(t2) {
    this._$EO?.delete(t2);
  }
  _$E_() {
    const t2 = /* @__PURE__ */ new Map(), s2 = this.constructor.elementProperties;
    for (const i2 of s2.keys()) this.hasOwnProperty(i2) && (t2.set(i2, this[i2]), delete this[i2]);
    t2.size > 0 && (this._$Ep = t2);
  }
  createRenderRoot() {
    const t2 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return S$1(t2, this.constructor.elementStyles), t2;
  }
  connectedCallback() {
    this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(true), this._$EO?.forEach((t2) => t2.hostConnected?.());
  }
  enableUpdating(t2) {
  }
  disconnectedCallback() {
    this._$EO?.forEach((t2) => t2.hostDisconnected?.());
  }
  attributeChangedCallback(t2, s2, i2) {
    this._$AK(t2, i2);
  }
  _$ET(t2, s2) {
    const i2 = this.constructor.elementProperties.get(t2), e2 = this.constructor._$Eu(t2, i2);
    if (void 0 !== e2 && true === i2.reflect) {
      const h2 = (void 0 !== i2.converter?.toAttribute ? i2.converter : u$1).toAttribute(s2, i2.type);
      this._$Em = t2, null == h2 ? this.removeAttribute(e2) : this.setAttribute(e2, h2), this._$Em = null;
    }
  }
  _$AK(t2, s2) {
    const i2 = this.constructor, e2 = i2._$Eh.get(t2);
    if (void 0 !== e2 && this._$Em !== e2) {
      const t3 = i2.getPropertyOptions(e2), h2 = "function" == typeof t3.converter ? { fromAttribute: t3.converter } : void 0 !== t3.converter?.fromAttribute ? t3.converter : u$1;
      this._$Em = e2;
      const r2 = h2.fromAttribute(s2, t3.type);
      this[e2] = r2 ?? this._$Ej?.get(e2) ?? r2, this._$Em = null;
    }
  }
  requestUpdate(t2, s2, i2, e2 = false, h2) {
    if (void 0 !== t2) {
      const r2 = this.constructor;
      if (false === e2 && (h2 = this[t2]), i2 ??= r2.getPropertyOptions(t2), !((i2.hasChanged ?? f$1)(h2, s2) || i2.useDefault && i2.reflect && h2 === this._$Ej?.get(t2) && !this.hasAttribute(r2._$Eu(t2, i2)))) return;
      this.C(t2, s2, i2);
    }
    false === this.isUpdatePending && (this._$ES = this._$EP());
  }
  C(t2, s2, { useDefault: i2, reflect: e2, wrapped: h2 }, r2) {
    i2 && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t2) && (this._$Ej.set(t2, r2 ?? s2 ?? this[t2]), true !== h2 || void 0 !== r2) || (this._$AL.has(t2) || (this.hasUpdated || i2 || (s2 = void 0), this._$AL.set(t2, s2)), true === e2 && this._$Em !== t2 && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t2));
  }
  async _$EP() {
    this.isUpdatePending = true;
    try {
      await this._$ES;
    } catch (t3) {
      Promise.reject(t3);
    }
    const t2 = this.scheduleUpdate();
    return null != t2 && await t2, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
        for (const [t4, s3] of this._$Ep) this[t4] = s3;
        this._$Ep = void 0;
      }
      const t3 = this.constructor.elementProperties;
      if (t3.size > 0) for (const [s3, i2] of t3) {
        const { wrapped: t4 } = i2, e2 = this[s3];
        true !== t4 || this._$AL.has(s3) || void 0 === e2 || this.C(s3, void 0, i2, e2);
      }
    }
    let t2 = false;
    const s2 = this._$AL;
    try {
      t2 = this.shouldUpdate(s2), t2 ? (this.willUpdate(s2), this._$EO?.forEach((t3) => t3.hostUpdate?.()), this.update(s2)) : this._$EM();
    } catch (s3) {
      throw t2 = false, this._$EM(), s3;
    }
    t2 && this._$AE(s2);
  }
  willUpdate(t2) {
  }
  _$AE(t2) {
    this._$EO?.forEach((t3) => t3.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t2)), this.updated(t2);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(t2) {
    return true;
  }
  update(t2) {
    this._$Eq &&= this._$Eq.forEach((t3) => this._$ET(t3, this[t3])), this._$EM();
  }
  updated(t2) {
  }
  firstUpdated(t2) {
  }
};
y$1.elementStyles = [], y$1.shadowRootOptions = { mode: "open" }, y$1[d$1("elementProperties")] = /* @__PURE__ */ new Map(), y$1[d$1("finalized")] = /* @__PURE__ */ new Map(), p$1?.({ ReactiveElement: y$1 }), (a$1.reactiveElementVersions ??= []).push("2.1.2");
const t = globalThis, i$1 = (t2) => t2, s$1 = t.trustedTypes, e = s$1 ? s$1.createPolicy("lit-html", { createHTML: (t2) => t2 }) : void 0, h = "$lit$", o$1 = `lit$${Math.random().toFixed(9).slice(2)}$`, n2 = "?" + o$1, r = `<${n2}>`, l = document, c = () => l.createComment(""), a = (t2) => null === t2 || "object" != typeof t2 && "function" != typeof t2, u = Array.isArray, d = (t2) => u(t2) || "function" == typeof t2?.[Symbol.iterator], f = "[ 	\n\f\r]", v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, _ = /-->/g, m = />/g, p = RegExp(`>|${f}(?:([^\\s"'>=/]+)(${f}*=${f}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g"), g = /'/g, $ = /"/g, y2 = /^(?:script|style|textarea|title)$/i, x = (t2) => (i2, ...s2) => ({ _$litType$: t2, strings: i2, values: s2 }), b = x(1), E = /* @__PURE__ */ Symbol.for("lit-noChange"), A = /* @__PURE__ */ Symbol.for("lit-nothing"), C = /* @__PURE__ */ new WeakMap(), P = l.createTreeWalker(l, 129);
function V(t2, i2) {
  if (!u(t2) || !t2.hasOwnProperty("raw")) throw Error("invalid template strings array");
  return void 0 !== e ? e.createHTML(i2) : i2;
}
const N = (t2, i2) => {
  const s2 = t2.length - 1, e2 = [];
  let n3, l2 = 2 === i2 ? "<svg>" : 3 === i2 ? "<math>" : "", c2 = v;
  for (let i3 = 0; i3 < s2; i3++) {
    const s3 = t2[i3];
    let a2, u2, d2 = -1, f2 = 0;
    for (; f2 < s3.length && (c2.lastIndex = f2, u2 = c2.exec(s3), null !== u2); ) f2 = c2.lastIndex, c2 === v ? "!--" === u2[1] ? c2 = _ : void 0 !== u2[1] ? c2 = m : void 0 !== u2[2] ? (y2.test(u2[2]) && (n3 = RegExp("</" + u2[2], "g")), c2 = p) : void 0 !== u2[3] && (c2 = p) : c2 === p ? ">" === u2[0] ? (c2 = n3 ?? v, d2 = -1) : void 0 === u2[1] ? d2 = -2 : (d2 = c2.lastIndex - u2[2].length, a2 = u2[1], c2 = void 0 === u2[3] ? p : '"' === u2[3] ? $ : g) : c2 === $ || c2 === g ? c2 = p : c2 === _ || c2 === m ? c2 = v : (c2 = p, n3 = void 0);
    const x2 = c2 === p && t2[i3 + 1].startsWith("/>") ? " " : "";
    l2 += c2 === v ? s3 + r : d2 >= 0 ? (e2.push(a2), s3.slice(0, d2) + h + s3.slice(d2) + o$1 + x2) : s3 + o$1 + (-2 === d2 ? i3 : x2);
  }
  return [V(t2, l2 + (t2[s2] || "<?>") + (2 === i2 ? "</svg>" : 3 === i2 ? "</math>" : "")), e2];
};
class S {
  constructor({ strings: t2, _$litType$: i2 }, e2) {
    let r2;
    this.parts = [];
    let l2 = 0, a2 = 0;
    const u2 = t2.length - 1, d2 = this.parts, [f2, v2] = N(t2, i2);
    if (this.el = S.createElement(f2, e2), P.currentNode = this.el.content, 2 === i2 || 3 === i2) {
      const t3 = this.el.content.firstChild;
      t3.replaceWith(...t3.childNodes);
    }
    for (; null !== (r2 = P.nextNode()) && d2.length < u2; ) {
      if (1 === r2.nodeType) {
        if (r2.hasAttributes()) for (const t3 of r2.getAttributeNames()) if (t3.endsWith(h)) {
          const i3 = v2[a2++], s2 = r2.getAttribute(t3).split(o$1), e3 = /([.?@])?(.*)/.exec(i3);
          d2.push({ type: 1, index: l2, name: e3[2], strings: s2, ctor: "." === e3[1] ? I : "?" === e3[1] ? L : "@" === e3[1] ? z : H }), r2.removeAttribute(t3);
        } else t3.startsWith(o$1) && (d2.push({ type: 6, index: l2 }), r2.removeAttribute(t3));
        if (y2.test(r2.tagName)) {
          const t3 = r2.textContent.split(o$1), i3 = t3.length - 1;
          if (i3 > 0) {
            r2.textContent = s$1 ? s$1.emptyScript : "";
            for (let s2 = 0; s2 < i3; s2++) r2.append(t3[s2], c()), P.nextNode(), d2.push({ type: 2, index: ++l2 });
            r2.append(t3[i3], c());
          }
        }
      } else if (8 === r2.nodeType) if (r2.data === n2) d2.push({ type: 2, index: l2 });
      else {
        let t3 = -1;
        for (; -1 !== (t3 = r2.data.indexOf(o$1, t3 + 1)); ) d2.push({ type: 7, index: l2 }), t3 += o$1.length - 1;
      }
      l2++;
    }
  }
  static createElement(t2, i2) {
    const s2 = l.createElement("template");
    return s2.innerHTML = t2, s2;
  }
}
function M(t2, i2, s2 = t2, e2) {
  if (i2 === E) return i2;
  let h2 = void 0 !== e2 ? s2._$Co?.[e2] : s2._$Cl;
  const o2 = a(i2) ? void 0 : i2._$litDirective$;
  return h2?.constructor !== o2 && (h2?._$AO?.(false), void 0 === o2 ? h2 = void 0 : (h2 = new o2(t2), h2._$AT(t2, s2, e2)), void 0 !== e2 ? (s2._$Co ??= [])[e2] = h2 : s2._$Cl = h2), void 0 !== h2 && (i2 = M(t2, h2._$AS(t2, i2.values), h2, e2)), i2;
}
class R {
  constructor(t2, i2) {
    this._$AV = [], this._$AN = void 0, this._$AD = t2, this._$AM = i2;
  }
  get parentNode() {
    return this._$AM.parentNode;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  u(t2) {
    const { el: { content: i2 }, parts: s2 } = this._$AD, e2 = (t2?.creationScope ?? l).importNode(i2, true);
    P.currentNode = e2;
    let h2 = P.nextNode(), o2 = 0, n3 = 0, r2 = s2[0];
    for (; void 0 !== r2; ) {
      if (o2 === r2.index) {
        let i3;
        2 === r2.type ? i3 = new k(h2, h2.nextSibling, this, t2) : 1 === r2.type ? i3 = new r2.ctor(h2, r2.name, r2.strings, this, t2) : 6 === r2.type && (i3 = new Z(h2, this, t2)), this._$AV.push(i3), r2 = s2[++n3];
      }
      o2 !== r2?.index && (h2 = P.nextNode(), o2++);
    }
    return P.currentNode = l, e2;
  }
  p(t2) {
    let i2 = 0;
    for (const s2 of this._$AV) void 0 !== s2 && (void 0 !== s2.strings ? (s2._$AI(t2, s2, i2), i2 += s2.strings.length - 2) : s2._$AI(t2[i2])), i2++;
  }
}
class k {
  get _$AU() {
    return this._$AM?._$AU ?? this._$Cv;
  }
  constructor(t2, i2, s2, e2) {
    this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t2, this._$AB = i2, this._$AM = s2, this.options = e2, this._$Cv = e2?.isConnected ?? true;
  }
  get parentNode() {
    let t2 = this._$AA.parentNode;
    const i2 = this._$AM;
    return void 0 !== i2 && 11 === t2?.nodeType && (t2 = i2.parentNode), t2;
  }
  get startNode() {
    return this._$AA;
  }
  get endNode() {
    return this._$AB;
  }
  _$AI(t2, i2 = this) {
    t2 = M(this, t2, i2), a(t2) ? t2 === A || null == t2 || "" === t2 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t2 !== this._$AH && t2 !== E && this._(t2) : void 0 !== t2._$litType$ ? this.$(t2) : void 0 !== t2.nodeType ? this.T(t2) : d(t2) ? this.k(t2) : this._(t2);
  }
  O(t2) {
    return this._$AA.parentNode.insertBefore(t2, this._$AB);
  }
  T(t2) {
    this._$AH !== t2 && (this._$AR(), this._$AH = this.O(t2));
  }
  _(t2) {
    this._$AH !== A && a(this._$AH) ? this._$AA.nextSibling.data = t2 : this.T(l.createTextNode(t2)), this._$AH = t2;
  }
  $(t2) {
    const { values: i2, _$litType$: s2 } = t2, e2 = "number" == typeof s2 ? this._$AC(t2) : (void 0 === s2.el && (s2.el = S.createElement(V(s2.h, s2.h[0]), this.options)), s2);
    if (this._$AH?._$AD === e2) this._$AH.p(i2);
    else {
      const t3 = new R(e2, this), s3 = t3.u(this.options);
      t3.p(i2), this.T(s3), this._$AH = t3;
    }
  }
  _$AC(t2) {
    let i2 = C.get(t2.strings);
    return void 0 === i2 && C.set(t2.strings, i2 = new S(t2)), i2;
  }
  k(t2) {
    u(this._$AH) || (this._$AH = [], this._$AR());
    const i2 = this._$AH;
    let s2, e2 = 0;
    for (const h2 of t2) e2 === i2.length ? i2.push(s2 = new k(this.O(c()), this.O(c()), this, this.options)) : s2 = i2[e2], s2._$AI(h2), e2++;
    e2 < i2.length && (this._$AR(s2 && s2._$AB.nextSibling, e2), i2.length = e2);
  }
  _$AR(t2 = this._$AA.nextSibling, s2) {
    for (this._$AP?.(false, true, s2); t2 !== this._$AB; ) {
      const s3 = i$1(t2).nextSibling;
      i$1(t2).remove(), t2 = s3;
    }
  }
  setConnected(t2) {
    void 0 === this._$AM && (this._$Cv = t2, this._$AP?.(t2));
  }
}
class H {
  get tagName() {
    return this.element.tagName;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  constructor(t2, i2, s2, e2, h2) {
    this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t2, this.name = i2, this._$AM = e2, this.options = h2, s2.length > 2 || "" !== s2[0] || "" !== s2[1] ? (this._$AH = Array(s2.length - 1).fill(new String()), this.strings = s2) : this._$AH = A;
  }
  _$AI(t2, i2 = this, s2, e2) {
    const h2 = this.strings;
    let o2 = false;
    if (void 0 === h2) t2 = M(this, t2, i2, 0), o2 = !a(t2) || t2 !== this._$AH && t2 !== E, o2 && (this._$AH = t2);
    else {
      const e3 = t2;
      let n3, r2;
      for (t2 = h2[0], n3 = 0; n3 < h2.length - 1; n3++) r2 = M(this, e3[s2 + n3], i2, n3), r2 === E && (r2 = this._$AH[n3]), o2 ||= !a(r2) || r2 !== this._$AH[n3], r2 === A ? t2 = A : t2 !== A && (t2 += (r2 ?? "") + h2[n3 + 1]), this._$AH[n3] = r2;
    }
    o2 && !e2 && this.j(t2);
  }
  j(t2) {
    t2 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t2 ?? "");
  }
}
class I extends H {
  constructor() {
    super(...arguments), this.type = 3;
  }
  j(t2) {
    this.element[this.name] = t2 === A ? void 0 : t2;
  }
}
class L extends H {
  constructor() {
    super(...arguments), this.type = 4;
  }
  j(t2) {
    this.element.toggleAttribute(this.name, !!t2 && t2 !== A);
  }
}
class z extends H {
  constructor(t2, i2, s2, e2, h2) {
    super(t2, i2, s2, e2, h2), this.type = 5;
  }
  _$AI(t2, i2 = this) {
    if ((t2 = M(this, t2, i2, 0) ?? A) === E) return;
    const s2 = this._$AH, e2 = t2 === A && s2 !== A || t2.capture !== s2.capture || t2.once !== s2.once || t2.passive !== s2.passive, h2 = t2 !== A && (s2 === A || e2);
    e2 && this.element.removeEventListener(this.name, this, s2), h2 && this.element.addEventListener(this.name, this, t2), this._$AH = t2;
  }
  handleEvent(t2) {
    "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t2) : this._$AH.handleEvent(t2);
  }
}
class Z {
  constructor(t2, i2, s2) {
    this.element = t2, this.type = 6, this._$AN = void 0, this._$AM = i2, this.options = s2;
  }
  get _$AU() {
    return this._$AM._$AU;
  }
  _$AI(t2) {
    M(this, t2);
  }
}
const B = t.litHtmlPolyfillSupport;
B?.(S, k), (t.litHtmlVersions ??= []).push("3.3.3");
const D = (t2, i2, s2) => {
  const e2 = s2?.renderBefore ?? i2;
  let h2 = e2._$litPart$;
  if (void 0 === h2) {
    const t3 = s2?.renderBefore ?? null;
    e2._$litPart$ = h2 = new k(i2.insertBefore(c(), t3), t3, void 0, s2 ?? {});
  }
  return h2._$AI(t2), h2;
};
const s = globalThis;
class i extends y$1 {
  constructor() {
    super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
  }
  createRenderRoot() {
    const t2 = super.createRenderRoot();
    return this.renderOptions.renderBefore ??= t2.firstChild, t2;
  }
  update(t2) {
    const r2 = this.render();
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t2), this._$Do = D(r2, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    super.connectedCallback(), this._$Do?.setConnected(true);
  }
  disconnectedCallback() {
    super.disconnectedCallback(), this._$Do?.setConnected(false);
  }
  render() {
    return E;
  }
}
i._$litElement$ = true, i["finalized"] = true, s.litElementHydrateSupport?.({ LitElement: i });
const o = s.litElementPolyfillSupport;
o?.({ LitElement: i });
(s.litElementVersions ??= []).push("4.2.2");
const FEATURE_NAMES = [
  "listAgents",
  "updateAgent",
  "listAgentFiles",
  "getAgentFile",
  "setAgentFile",
  "listModels",
  "listSessions",
  "createSession"
];
const ERROR_MESSAGES = {
  CONNECT_FAILED: "Connection failed",
  DISCONNECT_FAILED: "Disconnect failed",
  CONNECTION_EXPIRED: "Connection expired",
  OPERATION_FAILED: "Request failed"
};
class AgentStudioApiError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = "AgentStudioApiError";
  }
}
const CONNECTION_ID_PATTERN = /^[0-9a-f]{64}$/;
function isRecord$3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConnectResult(value) {
  if (!isRecord$3(value) || value.ok !== true || !CONNECTION_ID_PATTERN.test(String(value.connectionId))) {
    return void 0;
  }
  if (!isRecord$3(value.features)) return void 0;
  const features = {};
  for (const name of FEATURE_NAMES) {
    if (typeof value.features[name] !== "boolean") return void 0;
    features[name] = value.features[name];
  }
  return { connectionId: String(value.connectionId), features };
}
async function post(fetcher, body, keepalive = false) {
  const response = await fetcher("./api", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
    credentials: "omit",
    ...keepalive ? { keepalive: true } : {}
  });
  if (!response.ok) throw new Error("request failed");
  return await response.json();
}
function createAgentStudioApiClient(fetcher = globalThis.fetch) {
  return {
    async connect(token) {
      try {
        const value = await post(fetcher, JSON.stringify({ action: "connect", token }));
        const result = parseConnectResult(value);
        if (!result) throw new Error("invalid response");
        return result;
      } catch {
        throw new AgentStudioApiError("CONNECT_FAILED");
      }
    },
    async disconnect(connectionId, options) {
      try {
        const value = await post(
          fetcher,
          JSON.stringify({ action: "disconnect", connectionId }),
          options?.keepalive
        );
        if (!isRecord$3(value) || value.ok !== true) throw new Error("invalid response");
      } catch {
        throw new AgentStudioApiError("DISCONNECT_FAILED");
      }
    },
    async operation(connectionId, operation, payload) {
      let value;
      try {
        value = await post(
          fetcher,
          JSON.stringify({ action: "operation", connectionId, operation, payload })
        );
      } catch {
        throw new AgentStudioApiError("OPERATION_FAILED");
      }
      if (!isRecord$3(value)) throw new AgentStudioApiError("OPERATION_FAILED");
      if (value.ok === true) return value.data;
      const code = isRecord$3(value.error) ? value.error.code : void 0;
      throw new AgentStudioApiError(
        code === "CONNECTION_EXPIRED" ? "CONNECTION_EXPIRED" : "OPERATION_FAILED"
      );
    }
  };
}
const AGENT_COLOR_PALETTE = [
  "#e2664f",
  "#e39b3c",
  "#d8c14a",
  "#7fbf5a",
  "#4fb59a",
  "#4f9ed8",
  "#7b7fe0",
  "#b76fd0",
  "#d6608f",
  "#8c8f9a"
];
const AGENT_COLOR_NAMES = {
  "#e2664f": "Coral",
  "#e39b3c": "Amber",
  "#d8c14a": "Brass",
  "#7fbf5a": "Moss",
  "#4fb59a": "Teal",
  "#4f9ed8": "Azure",
  "#7b7fe0": "Indigo",
  "#b76fd0": "Orchid",
  "#d6608f": "Rose",
  "#8c8f9a": "Slate"
};
const SHORT_HEX = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const LONG_HEX = /^#?[0-9a-f]{6}$/i;
function normalizeHexColor(value) {
  if (typeof value !== "string") return void 0;
  const candidate = value.trim();
  const short = SHORT_HEX.exec(candidate);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (LONG_HEX.test(candidate)) {
    return `#${candidate.replace("#", "")}`.toLowerCase();
  }
  return void 0;
}
const LIST_UNAVAILABLE = "This Gateway does not expose agent listing.";
const LIST_FAILED$1 = "Agent directory unavailable.";
const COLOR_INVALID = "Enter a color as #rrggbb.";
const COLOR_FAILED = "Could not save that color. Reverting.";
const UPDATE_FAILED = "Could not update this agent.";
function isRecord$2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function parseAgent(value) {
  if (!isRecord$2(value) || typeof value.id !== "string" || value.id.length === 0) return void 0;
  const identity = isRecord$2(value.identity) ? value.identity : void 0;
  const model = isRecord$2(value.model) ? value.model : void 0;
  return {
    id: value.id,
    label: optionalString(identity?.name) ?? optionalString(value.name) ?? value.id,
    emoji: optionalString(identity?.emoji),
    model: optionalString(model?.primary),
    workspaceGit: typeof value.workspaceGit === "boolean" ? value.workspaceGit : void 0
  };
}
function parseAgentsResponse(value) {
  if (!isRecord$2(value)) return { agents: [] };
  const agents = Array.isArray(value.agents) ? value.agents.map(parseAgent).filter((agent) => agent !== void 0) : [];
  return { defaultId: optionalString(value.defaultId), agents };
}
function parseColorsResponse(value) {
  if (!isRecord$2(value) || !isRecord$2(value.colors)) return {};
  const colors = {};
  for (const [agentId, color] of Object.entries(value.colors)) {
    const normalized = normalizeHexColor(color);
    if (normalized) colors[agentId] = normalized;
  }
  return colors;
}
function sortAgents(agents, defaultId) {
  return [...agents].sort((left, right) => {
    if (left.id === defaultId) return right.id === defaultId ? 0 : -1;
    if (right.id === defaultId) return 1;
    const leftLabel = left.label.toLowerCase();
    const rightLabel = right.label.toLowerCase();
    if (leftLabel !== rightLabel) return leftLabel < rightLabel ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}
function filterAgents(agents, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...agents];
  return agents.filter(
    (agent) => agent.label.toLowerCase().includes(needle) || agent.id.toLowerCase().includes(needle)
  );
}
function createAgentDirectoryStore(options) {
  const { api, connectionId, features } = options;
  const listeners = /* @__PURE__ */ new Set();
  let status = "idle";
  let all = [];
  let query = "";
  let selectedId;
  let errorText;
  let colorErrorText;
  let updateErrorText;
  let updatingAgentId;
  const colorMutations = /* @__PURE__ */ new Map();
  const agentMutations = /* @__PURE__ */ new Map();
  function claimMutation(mutations, id) {
    const next = (mutations.get(id) ?? 0) + 1;
    mutations.set(id, next);
    return next;
  }
  function snapshot() {
    return {
      status,
      agents: filterAgents(all, query),
      totalCount: all.length,
      query,
      selectedId,
      selectedAgent: all.find((agent) => agent.id === selectedId),
      errorText,
      colorErrorText,
      updateErrorText,
      updatingAgentId
    };
  }
  function notify() {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }
  function applyColors(colors) {
    all = all.map((agent) => ({ ...agent, color: colors[agent.id] }));
  }
  async function loadColors() {
    try {
      return parseColorsResponse(await api.operation(connectionId, "colors.list", {}));
    } catch {
      return {};
    }
  }
  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      if (!features.listAgents) {
        status = "error";
        errorText = LIST_UNAVAILABLE;
        notify();
        return;
      }
      status = "loading";
      errorText = void 0;
      notify();
      let listed;
      try {
        listed = parseAgentsResponse(await api.operation(connectionId, "listAgents", {}));
      } catch {
        status = "error";
        all = [];
        selectedId = void 0;
        errorText = LIST_FAILED$1;
        notify();
        return;
      }
      const colors = await loadColors();
      all = sortAgents(listed.agents, listed.defaultId);
      applyColors(colors);
      selectedId = all.some((agent) => agent.id === listed.defaultId) ? listed.defaultId : all[0]?.id;
      status = "ready";
      errorText = void 0;
      notify();
    },
    select(agentId) {
      if (!all.some((agent) => agent.id === agentId) || agentId === selectedId) return;
      selectedId = agentId;
      notify();
    },
    setQuery(next) {
      if (next === query) return;
      query = next;
      notify();
    },
    async setColor(agentId, color) {
      const normalized = normalizeHexColor(color);
      const index = all.findIndex((agent) => agent.id === agentId);
      if (index < 0) return;
      if (!normalized) {
        colorErrorText = COLOR_INVALID;
        notify();
        return;
      }
      const previous = all[index].color;
      const mutation = claimMutation(colorMutations, agentId);
      all = all.map((agent) => agent.id === agentId ? { ...agent, color: normalized } : agent);
      colorErrorText = void 0;
      notify();
      try {
        await api.operation(connectionId, "colors.set", { agentId, color: normalized });
      } catch {
        if (colorMutations.get(agentId) !== mutation) return;
        all = all.map((agent) => agent.id === agentId ? { ...agent, color: previous } : agent);
        colorErrorText = COLOR_FAILED;
        notify();
      }
    },
    async updateAgent(agentId, patch) {
      const index = all.findIndex((agent) => agent.id === agentId);
      if (index < 0) return;
      const payload = { agentId };
      if (patch.name !== void 0) payload.name = patch.name;
      if (patch.model !== void 0) payload.model = patch.model;
      if (Object.keys(payload).length < 2) return;
      const previous = all[index];
      const mutation = claimMutation(agentMutations, agentId);
      all = all.map(
        (agent) => agent.id === agentId ? {
          ...agent,
          label: patch.name ?? agent.label,
          model: patch.model ?? agent.model
        } : agent
      );
      updateErrorText = void 0;
      updatingAgentId = agentId;
      notify();
      try {
        await api.operation(connectionId, "updateAgent", payload);
      } catch {
        if (agentMutations.get(agentId) !== mutation) return;
        all = all.map((agent) => agent.id === agentId ? previous : agent);
        updateErrorText = UPDATE_FAILED;
      } finally {
        if (agentMutations.get(agentId) === mutation) {
          updatingAgentId = void 0;
          notify();
        }
      }
    }
  };
}
const PERSONA_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md"
];
const MAX_PERSONA_CHARACTERS = 6e4;
const FILES_UNAVAILABLE = "This Gateway does not expose agent files.";
const LIST_FAILED = "Could not load this agent's files.";
const LOAD_FAILED = "Could not load this file.";
const SAVE_FAILED = "Could not save this file.";
const TOO_LARGE = "This file is too large to save (60,000 characters max).";
const KEY_SEPARATOR = "|";
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isExpired(error) {
  return error instanceof AgentStudioApiError && error.code === "CONNECTION_EXPIRED";
}
function parseFileEntries(value) {
  const reported = /* @__PURE__ */ new Map();
  if (isRecord$1(value) && Array.isArray(value.files)) {
    for (const file of value.files) {
      if (isRecord$1(file) && typeof file.name === "string") {
        reported.set(file.name, file.missing === true);
      }
    }
  }
  return PERSONA_FILES.map((name) => ({
    name,
    missing: reported.get(name) ?? true
  }));
}
function parseFileContent(value) {
  if (!isRecord$1(value) || !isRecord$1(value.file)) return void 0;
  if (value.file.missing === true) return void 0;
  return typeof value.file.content === "string" ? value.file.content : "";
}
function editorFor(name, content) {
  return {
    name,
    status: "ready",
    missing: content === void 0,
    creating: false,
    original: content ?? "",
    draft: content ?? "",
    dirty: false,
    saving: false,
    saved: false
  };
}
function createPersonaStore(options) {
  const { api, connectionId, features } = options;
  const available = features.listAgentFiles && features.getAgentFile;
  const listeners = /* @__PURE__ */ new Set();
  const cache = /* @__PURE__ */ new Map();
  let agentId;
  let status = "idle";
  let errorText;
  let files = [];
  let selected;
  let expired = false;
  let generation = 0;
  function cacheKey(agent, name) {
    return `${agent}${KEY_SEPARATOR}${name}`;
  }
  function current() {
    return agentId && selected ? cache.get(cacheKey(agentId, selected)) : void 0;
  }
  function snapshot() {
    const file = current();
    return {
      agentId,
      status,
      errorText,
      files: files.map((entry) => ({ ...entry })),
      selected,
      file: file ? { ...file } : void 0,
      canSave: features.setAgentFile,
      expired
    };
  }
  function notify() {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }
  function patch(agent, name, changes) {
    const key = cacheKey(agent, name);
    const existing = cache.get(key);
    if (!existing) return;
    cache.set(key, { ...existing, ...changes });
    notify();
  }
  function update(changes) {
    if (!agentId || !selected) return;
    patch(agentId, selected, changes);
  }
  function markMissing(agent, name, missing) {
    if (agent !== agentId) return;
    files = files.map((entry) => entry.name === name ? { ...entry, missing } : entry);
  }
  function noteFailure(agent, name, error, message) {
    if (isExpired(error)) {
      expired = true;
      patch(agent, name, { saving: false });
      return;
    }
    patch(agent, name, { saving: false, errorText: message });
  }
  async function fetchContent(agent, name) {
    const response = await api.operation(connectionId, "getAgentFile", { agentId: agent, name });
    return parseFileContent(response);
  }
  async function writeContent(agent, name, content) {
    await api.operation(connectionId, "setAgentFile", { agentId: agent, name, content });
  }
  async function saveDraft() {
    const file = current();
    const agent = agentId;
    if (!file || !agent || !features.setAgentFile) return;
    const name = file.name;
    if (file.draft.length > MAX_PERSONA_CHARACTERS) {
      patch(agent, name, { errorText: TOO_LARGE, saved: false });
      return;
    }
    patch(agent, name, { saving: true, errorText: void 0, saved: false });
    let serverContent;
    try {
      serverContent = await fetchContent(agent, name);
    } catch (error) {
      noteFailure(agent, name, error, SAVE_FAILED);
      return;
    }
    if ((serverContent ?? "") !== file.original) {
      patch(agent, name, {
        saving: false,
        conflict: { server: serverContent ?? "", local: file.draft }
      });
      return;
    }
    try {
      await writeContent(agent, name, file.draft);
    } catch (error) {
      noteFailure(agent, name, error, SAVE_FAILED);
      return;
    }
    markMissing(agent, name, false);
    patch(agent, name, {
      saving: false,
      saved: true,
      dirty: false,
      missing: false,
      creating: false,
      original: file.draft,
      conflict: void 0
    });
  }
  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async selectAgent(nextAgentId) {
      generation += 1;
      const requestGeneration = generation;
      agentId = nextAgentId;
      selected = void 0;
      errorText = void 0;
      if (!available) {
        status = "error";
        errorText = FILES_UNAVAILABLE;
        files = [];
        notify();
        return;
      }
      status = "loading";
      notify();
      let entries;
      let failure;
      try {
        entries = parseFileEntries(
          await api.operation(connectionId, "listAgentFiles", { agentId: nextAgentId })
        );
      } catch (error) {
        failure = error;
      }
      if (requestGeneration !== generation) return;
      if (entries) {
        files = entries;
        status = "ready";
      } else {
        if (isExpired(failure)) expired = true;
        status = "error";
        files = [];
        errorText = LIST_FAILED;
      }
      notify();
    },
    async selectFile(name) {
      const agent = agentId;
      if (!agent || !available || !PERSONA_FILES.includes(name)) {
        return;
      }
      const requestGeneration = generation;
      selected = name;
      const key = cacheKey(agent, name);
      if (cache.get(key)) {
        notify();
        return;
      }
      cache.set(key, {
        name,
        status: "loading",
        missing: false,
        creating: false,
        original: "",
        draft: "",
        dirty: false,
        saving: false,
        saved: false
      });
      notify();
      try {
        const content = await fetchContent(agent, name);
        cache.set(key, editorFor(name, content));
        markMissing(agent, name, content === void 0);
      } catch (error) {
        if (isExpired(error)) expired = true;
        cache.set(key, {
          ...editorFor(name, ""),
          status: "error",
          errorText: LOAD_FAILED
        });
      }
      if (requestGeneration === generation) notify();
    },
    setDraft(text) {
      const file = current();
      if (!file) return;
      update({ draft: text, dirty: text !== file.original, saved: false, errorText: void 0 });
    },
    createFile() {
      const file = current();
      if (!file || !file.missing) return;
      update({ creating: true, draft: "", original: "", dirty: false, errorText: void 0 });
    },
    async cancel() {
      const file = current();
      const agent = agentId;
      if (!file || !agent) return;
      const name = file.name;
      const requestGeneration = generation;
      patch(agent, name, {
        status: "loading",
        errorText: void 0,
        conflict: void 0,
        saved: false
      });
      try {
        const content = await fetchContent(agent, name);
        cache.set(cacheKey(agent, name), editorFor(name, content));
        markMissing(agent, name, content === void 0);
        if (requestGeneration === generation) notify();
      } catch (error) {
        noteFailure(agent, name, error, LOAD_FAILED);
        patch(agent, name, { status: "ready" });
      }
    },
    save: saveDraft,
    async resolveConflict(choice) {
      const file = current();
      const agent = agentId;
      if (!file?.conflict || !agent) return;
      const name = file.name;
      if (choice === "use-server") {
        const server = file.conflict.server;
        markMissing(agent, name, false);
        patch(agent, name, {
          conflict: void 0,
          original: server,
          draft: server,
          dirty: false,
          missing: false,
          errorText: void 0
        });
        return;
      }
      patch(agent, name, { original: file.conflict.server, conflict: void 0, dirty: true });
      await saveDraft();
    }
  };
}
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LABEL = 256;
const MAX_MODEL = 256;
const MAX_TASK = 32768;
const CREATE_UNAVAILABLE = "This Gateway does not expose session creation.";
const CREATE_FAILED = "Could not create the session. Check the fields and try again.";
const NO_AGENT = "Select an agent before creating a session.";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimmed(value) {
  const text = value?.trim();
  return text ? text : void 0;
}
function validate(agentId, options) {
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
  const payload = { agentId };
  if (label) payload.label = label;
  if (model) payload.model = model;
  if (task) payload.task = task;
  if (options.worktree) payload.worktree = true;
  return { ok: true, payload, label };
}
function sessionKey(value) {
  if (!isRecord(value)) return void 0;
  return typeof value.key === "string" && value.key.length > 0 ? value.key : void 0;
}
function createSessionController(options) {
  const { api, connectionId, features } = options;
  const listeners = /* @__PURE__ */ new Set();
  let state = { status: "idle", advancedOpen: false };
  function set(next) {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  }
  async function findCreated(agentId, label) {
    if (!label || !features.listSessions) return void 0;
    try {
      const response = await api.operation(connectionId, "listSessions", {
        agentId,
        limit: 20,
        includeGlobal: false
      });
      if (!isRecord(response) || !Array.isArray(response.sessions)) return void 0;
      const match = response.sessions.find(
        (session) => isRecord(session) && session.agentId === agentId && session.label === label
      );
      return sessionKey(match);
    } catch {
      return void 0;
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
      set({ advancedOpen: open, errorText: void 0 });
    },
    reset() {
      set({ status: "idle", key: void 0, errorText: void 0, agentId: void 0 });
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
      set({ status: "creating", errorText: void 0, key: void 0, agentId });
      let key;
      try {
        key = sessionKey(await api.operation(connectionId, "createSession", validation.payload));
      } catch {
        key = await findCreated(agentId, validation.label);
        if (!key) {
          set({ status: "error", errorText: CREATE_FAILED });
          return;
        }
      }
      set({ status: "created", key, advancedOpen: false, errorText: void 0 });
    }
  };
}
const _SessionCreate = class _SessionCreate extends i {
  constructor() {
    super(...arguments);
    this.state = { status: "idle", advancedOpen: false };
    this.copied = false;
    this.localAdvanced = false;
    this.submitAdvanced = () => {
      const label = this.querySelector("#session-label")?.value;
      const model = this.querySelector("#session-model")?.value;
      const task = this.querySelector("#session-task")?.value;
      const worktree = this.querySelector("#session-worktree")?.checked === true;
      const options = {};
      if (label?.trim()) options.label = label.trim();
      if (model?.trim()) options.model = model.trim();
      if (task?.trim()) options.task = task.trim();
      if (worktree) options.worktree = true;
      this.emitCreate(options);
    };
  }
  createRenderRoot() {
    return this;
  }
  willUpdate(changed) {
    if (changed.has("state") && this.state.status === "created") this.localAdvanced = false;
    if (changed.has("agentId") && changed.get("agentId") !== this.agentId) {
      this.localAdvanced = false;
      this.copied = false;
    }
  }
  get advancedOpen() {
    return (this.localAdvanced || this.state.advancedOpen) && !this.belongsToAnotherAgent();
  }
  /** True when `state` describes an agent other than the one now on screen. */
  belongsToAnotherAgent() {
    return this.state.agentId !== void 0 && this.state.agentId !== this.agentId;
  }
  render() {
    if (this.features?.createSession !== true) {
      return b`
        <section class="session-create" aria-label="Sessions">
          <p class="session-notice" data-state="unavailable" role="status">
            This Gateway does not expose session creation.
          </p>
        </section>
      `;
    }
    const busy = this.state.status === "creating" && !this.belongsToAnotherAgent();
    return b`
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
        ${this.state.errorText && !this.belongsToAnotherAgent() ? b`<p class="session-error" role="alert">${this.state.errorText}</p>` : A}
        ${this.advancedOpen ? this.renderDialog(busy) : A}
        ${this.state.status === "created" && this.state.key && !this.belongsToAnotherAgent() ? this.renderResult(this.state.key) : A}
      </section>
    `;
  }
  renderDialog(busy) {
    return b`
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
  renderResult(key) {
    return b`
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
  emitCreate(options) {
    if (!this.agentId) return;
    this.copied = false;
    this.dispatchEvent(
      new CustomEvent("session-create", {
        detail: { agentId: this.agentId, options },
        bubbles: true
      })
    );
  }
  emitAdvanced(open) {
    this.localAdvanced = open;
    this.dispatchEvent(new CustomEvent("session-advanced", { detail: { open }, bubbles: true }));
  }
  async copy(key) {
    try {
      await navigator.clipboard?.writeText(key);
      this.copied = true;
    } catch {
      this.copied = false;
    }
  }
};
_SessionCreate.properties = {
  agentId: { attribute: false },
  features: { attribute: false },
  state: { attribute: false },
  copied: { state: true },
  localAdvanced: { state: true }
};
let SessionCreate = _SessionCreate;
if (!customElements.get("session-create")) {
  customElements.define("session-create", SessionCreate);
}
const IDLE_STATE$1 = {
  status: "idle",
  agents: [],
  totalCount: 0,
  query: ""
};
const NAVIGATION_KEYS = /* @__PURE__ */ new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const _AgentDirectory = class _AgentDirectory extends i {
  constructor() {
    super(...arguments);
    this.state = IDLE_STATE$1;
    this.customHexError = false;
    this.handleQueryInput = (event) => {
      const input = event.target;
      this.dispatchEvent(
        new CustomEvent("agent-query", { detail: { query: input.value }, bubbles: true })
      );
    };
    this.handleCustomHexKeydown = (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (this.openColorAgentId) this.applyCustomHex(this.openColorAgentId);
    };
    this.handleKeydown = (event) => {
      if (event.key === "Escape" && this.openColorAgentId) {
        event.stopPropagation();
        this.closeColorPicker();
        return;
      }
      if (!NAVIGATION_KEYS.has(event.key)) return;
      const target = event.target;
      if (!target?.classList.contains("agent-select")) return;
      const buttons = [...this.querySelectorAll(".agent-select")];
      const current = buttons.indexOf(target);
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
  }
  createRenderRoot() {
    return this;
  }
  render() {
    const { status, agents, totalCount, query } = this.state;
    return b`
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
        ${status === "error" ? b`<p class="directory-error" role="alert">${this.state.errorText}</p>` : A}
        ${status === "loading" ? b`<p class="directory-status" data-state="loading" role="status">Loading agents…</p>` : A}
        ${status === "ready" && totalCount === 0 ? b`<p class="directory-status" data-state="empty" role="status">
              No agents available on this Gateway.
            </p>` : A}
        ${status === "ready" && totalCount > 0 && agents.length === 0 ? b`<p class="directory-status" data-state="no-match" role="status">
              No agents match “${query}”.
            </p>` : A}
        ${agents.length > 0 ? b`<ul id="agent-list" class="agent-list" aria-label="Agents">
              ${agents.map((agent, index) => this.renderAgent(agent, index))}
            </ul>` : A}
        ${this.state.colorErrorText ? b`<p class="directory-error" data-error="color" role="status">
              ${this.state.colorErrorText}
            </p>` : A}
      </div>
    `;
  }
  renderAgent(agent, index) {
    const selected = agent.id === this.state.selectedId;
    const swatchStyle = agent.color ? `background-color: ${agent.color}` : "";
    return b`
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
          ${selected ? b`<span class="selected-marker" aria-hidden="true">▍</span
                ><span class="visually-hidden">Selected</span>` : A}
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
        ${this.openColorAgentId === agent.id ? this.renderColorPicker(agent) : A}
      </li>
    `;
  }
  renderColorPicker(agent) {
    return b`
      <div
        class="color-popover"
        role="dialog"
        aria-label=${`Color for ${agent.label}`}
      >
        <div class="palette" role="group" aria-label="Palette">
          ${AGENT_COLOR_PALETTE.map(
      (color) => b`
              <button
                class="palette-swatch"
                type="button"
                data-color=${color}
                style=${`background-color: ${color}`}
                aria-label=${AGENT_COLOR_NAMES[color] ?? color}
                aria-pressed=${agent.color === color ? "true" : "false"}
                @click=${() => this.emitColor(agent.id, color)}
              ></button>
            `
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
        ${this.customHexError ? b`<p class="hex-error" data-error="hex" role="alert">Enter a color as #rrggbb.</p>` : A}
      </div>
    `;
  }
  rovingTabIndex(index) {
    const selectedIndex = this.state.agents.findIndex(
      (agent) => agent.id === this.state.selectedId
    );
    const active = selectedIndex >= 0 ? selectedIndex : 0;
    return index === active ? 0 : -1;
  }
  toggleColorPicker(agentId) {
    this.openColorAgentId = this.openColorAgentId === agentId ? void 0 : agentId;
    this.customHexError = false;
  }
  closeColorPicker() {
    this.openColorAgentId = void 0;
    this.customHexError = false;
  }
  applyCustomHex(agentId) {
    const input = this.querySelector(".custom-hex");
    const color = normalizeHexColor(input?.value);
    if (!color) {
      this.customHexError = true;
      return;
    }
    this.emitColor(agentId, color);
  }
  emitSelect(agentId) {
    this.dispatchEvent(new CustomEvent("agent-select", { detail: { agentId }, bubbles: true }));
  }
  emitColor(agentId, color) {
    this.closeColorPicker();
    this.dispatchEvent(
      new CustomEvent("agent-color", { detail: { agentId, color }, bubbles: true })
    );
  }
};
_AgentDirectory.properties = {
  state: { attribute: false },
  openColorAgentId: { state: true },
  customHexError: { state: true }
};
let AgentDirectory = _AgentDirectory;
if (!customElements.get("agent-directory")) {
  customElements.define("agent-directory", AgentDirectory);
}
const _AgentOverview = class _AgentOverview extends i {
  constructor() {
    super(...arguments);
    this.saving = false;
    this.localError = "";
  }
  createRenderRoot() {
    return this;
  }
  willUpdate(changed) {
    if (!changed.has("agent")) return;
    const previous = changed.get("agent");
    if (previous?.id !== this.agent?.id) {
      this.draftName = void 0;
      this.draftModel = void 0;
      this.localError = "";
    }
  }
  render() {
    const agent = this.agent;
    if (!agent) {
      return b`
        <section class="overview" aria-label="Agent overview">
          <p class="overview-empty" role="status">Select an agent to see its settings.</p>
        </section>
      `;
    }
    const editable = this.features?.updateAgent === true;
    return b`
      <section class="overview" aria-label="Agent overview">
        <h3 class="overview-title">${agent.emoji ? `${agent.emoji} ` : ""}${agent.label}</h3>
        <dl class="overview-facts">
          ${editable ? A : this.renderFact("name", "Name", agent.label)}
          ${this.renderFact("id", "Agent id", agent.id)}
          ${this.renderFact("model", "Model", agent.model ?? "Gateway default")}
          ${this.renderFact(
      "workspace",
      "Workspace",
      agent.workspaceGit === void 0 ? "Not reported" : agent.workspaceGit ? "Git repository" : "Plain directory"
    )}
        </dl>
        ${this.errorText || this.localError ? b`<p class="overview-error" role="alert">${this.localError || this.errorText}</p>` : A}
        ${editable ? this.renderEditor(agent) : this.renderReadOnly()}
      </section>
    `;
  }
  renderFact(key, term, value) {
    return b`
      <div class="overview-fact" data-fact=${key}>
        <dt>${term}</dt>
        <dd>${value}</dd>
      </div>
    `;
  }
  nameDraft(agent) {
    return (this.draftName ?? agent.label).trim();
  }
  modelDraft(agent) {
    return (this.draftModel ?? agent.model ?? "").trim();
  }
  /**
   * The fields this submission would actually send. `agents.update` has no way to
   * clear a model override, so an emptied model field is not a change.
   */
  changes(agent) {
    const name = this.nameDraft(agent);
    const model = this.modelDraft(agent);
    const detail = { agentId: agent.id };
    if (name && name !== agent.label) detail.name = name;
    if (model && model !== (agent.model ?? "")) detail.model = model;
    return detail;
  }
  renderEditor(agent) {
    const name = this.draftName ?? agent.label;
    const model = this.draftModel ?? agent.model ?? "";
    const dirty = this.nameDraft(agent) !== agent.label || this.modelDraft(agent) !== "" && this.modelDraft(agent) !== (agent.model ?? "");
    return b`
      <div class="overview-editor">
        <label for="overview-name">Display name</label>
        <input
          id="overview-name"
          type="text"
          maxlength="128"
          spellcheck="false"
          .value=${name}
          ?disabled=${this.saving}
          @input=${(event) => {
      this.draftName = event.target.value;
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
          @input=${(event) => {
      this.draftModel = event.target.value;
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
  renderReadOnly() {
    return b`
      <p class="overview-notice" data-state="read-only" role="status">
        This Gateway does not advertise agent updates. Change these settings from OpenClaw's
        built-in Agents page.
      </p>
    `;
  }
  submit(agent) {
    if (!this.nameDraft(agent)) {
      this.localError = "Name cannot be empty.";
      return;
    }
    const detail = this.changes(agent);
    if (Object.keys(detail).length < 2) return;
    this.localError = "";
    this.dispatchEvent(new CustomEvent("agent-update", { detail, bubbles: true }));
  }
};
_AgentOverview.properties = {
  agent: { attribute: false },
  features: { attribute: false },
  saving: { type: Boolean },
  errorText: { attribute: false },
  draftName: { state: true },
  draftModel: { state: true },
  localError: { state: true }
};
let AgentOverview = _AgentOverview;
if (!customElements.get("agent-overview")) {
  customElements.define("agent-overview", AgentOverview);
}
const IDLE_STATE = {
  status: "idle",
  files: [],
  canSave: false,
  expired: false
};
const _AgentPersona = class _AgentPersona extends i {
  constructor() {
    super(...arguments);
    this.state = IDLE_STATE;
    this.handleInput = (event) => {
      const editor = event.target;
      this.emit("persona-input", { text: editor.value });
    };
  }
  createRenderRoot() {
    return this;
  }
  render() {
    const { status, errorText, file } = this.state;
    return b`
      <section class="persona" aria-label="Persona files">
        ${status === "error" ? b`<p class="persona-error" role="alert">${errorText}</p>` : A}
        ${status !== "error" ? this.renderTabs() : A}
        ${this.state.expired ? b`<p class="persona-notice" data-state="expired" role="status">
              Connection expired. Reconnect to continue editing; unsaved text is kept here.
            </p>` : A}
        ${!this.state.canSave && status !== "error" ? b`<p class="persona-notice" data-state="read-only" role="status">
              This Gateway does not advertise agent file writes, so the editor is read-only.
            </p>` : A}
        ${file ? this.renderFile(file) : A}
      </section>
    `;
  }
  renderTabs() {
    const entries = this.state.files.length ? this.state.files : PERSONA_FILES.map((name) => ({ name, missing: true }));
    return b`
      <div class="persona-tabs" role="tablist" aria-label="Core files">
        ${entries.map(
      (entry) => b`
            <button
              class="persona-tab"
              type="button"
              role="tab"
              data-file=${entry.name}
              aria-selected=${this.state.selected === entry.name ? "true" : "false"}
              tabindex=${this.state.selected === entry.name ? 0 : -1}
              @click=${() => this.emit("persona-select", { name: entry.name })}
            >
              ${entry.name}${entry.missing ? b`<span class="tab-flag" title="Not created yet">·</span>` : A}
            </button>
          `
    )}
      </div>
    `;
  }
  renderFile(file) {
    if (file.status === "loading") {
      return b`<p class="persona-notice" data-state="loading" role="status">
        Loading ${file.name}…
      </p>`;
    }
    const showCreate = file.missing && !file.creating;
    return b`
      ${file.errorText ? b`<p class="persona-error" role="alert">${file.errorText}</p>` : A}
      ${file.saved && !file.dirty ? b`<p class="persona-notice" data-state="saved" role="status">Saved ${file.name}.</p>` : A}
      ${file.dirty ? b`<p class="persona-notice" data-state="dirty" role="status">
            Unsaved changes in ${file.name}.
          </p>` : A}
      ${showCreate ? b`
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
          ` : b`
            <label class="visually-hidden" for="persona-editor">${file.name}</label>
            <textarea
              id="persona-editor"
              class="persona-editor"
              spellcheck="false"
              .value=${file.draft}
              ?disabled=${this.state.expired || file.conflict !== void 0}
              ?readonly=${!this.state.canSave}
              @input=${this.handleInput}
            ></textarea>
            ${this.state.canSave ? this.renderActions(file) : A}
          `}
      ${file.conflict ? this.renderConflict(file) : A}
    `;
  }
  renderActions(file) {
    const locked = this.state.expired || file.saving || file.conflict !== void 0;
    return b`
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
  renderConflict(file) {
    const conflict = file.conflict;
    if (!conflict) return b``;
    return b`
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
  emitResolution(choice) {
    this.emit("persona-resolve", { choice });
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
};
_AgentPersona.properties = {
  state: { attribute: false }
};
let AgentPersona = _AgentPersona;
if (!customElements.get("agent-persona")) {
  customElements.define("agent-persona", AgentPersona);
}
const _AgentStudioApp = class _AgentStudioApp extends i {
  constructor() {
    super(...arguments);
    this.api = createAgentStudioApiClient();
    this.connecting = false;
    this.disconnecting = false;
    this.drawerOpen = false;
    this.statusText = "Gateway token required";
    this.errorText = "";
    this.mounted = false;
    this.lifecycleGeneration = 0;
    this.disconnects = /* @__PURE__ */ new Map();
    this.workspaceTab = "overview";
    this.personaSyncing = false;
    this.handleTokenKeydown = (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void this.handleConnect();
    };
    this.handleConnect = async () => {
      if (this.connecting) return;
      const input = this.querySelector("#gateway-token");
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
    this.handleDisconnect = async () => {
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
        this.querySelector("#gateway-token")?.focus();
      }
    };
    this.handleAgentSelect = (event) => {
      const { agentId } = event.detail;
      this.directory?.select(agentId);
    };
    this.handleAgentQuery = (event) => {
      const { query } = event.detail;
      this.directory?.setQuery(query);
    };
    this.handleAgentColor = (event) => {
      const { agentId, color } = event.detail;
      void this.directory?.setColor(agentId, color);
    };
    this.handleAgentUpdate = (event) => {
      const { agentId, name, model } = event.detail;
      void this.directory?.updateAgent(agentId, { name, model });
    };
    this.handleSessionCreate = (event) => {
      const { agentId, options } = event.detail;
      void this.sessions?.create(agentId, options);
    };
    this.handleSessionAdvanced = (event) => {
      const { open } = event.detail;
      this.sessions?.setAdvancedOpen(open);
    };
    this.handlePersonaSelect = (event) => {
      const { name } = event.detail;
      void this.persona?.selectFile(name);
    };
    this.handlePersonaInput = (event) => {
      const { text } = event.detail;
      this.persona?.setDraft(text);
    };
    this.handlePersonaSave = () => {
      void this.persona?.save();
    };
    this.handlePersonaCancel = () => {
      void this.persona?.cancel();
    };
    this.handlePersonaCreate = () => {
      this.persona?.createFile();
    };
    this.handlePersonaResolve = (event) => {
      const { choice } = event.detail;
      void this.persona?.resolveConflict(choice);
    };
  }
  connectedCallback() {
    super.connectedCallback();
    this.mounted = true;
    this.lifecycleGeneration += 1;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.teardown();
  }
  teardown() {
    if (!this.mounted && !this.connectionId && !this.connecting && !this.disconnecting) return;
    this.mounted = false;
    this.lifecycleGeneration += 1;
    const connectionId = this.connectionId;
    this.clearLocalConnection();
    const input = this.querySelector("#gateway-token");
    if (input) input.value = "";
    if (connectionId) {
      void this.disconnectConnection(connectionId, { keepalive: true });
    }
  }
  reactivate() {
    if (this.mounted || !this.isConnected) return;
    this.mounted = true;
    this.lifecycleGeneration += 1;
    this.clearLocalConnection();
  }
  createRenderRoot() {
    return this;
  }
  render() {
    return this.connectionId ? this.renderShell() : this.renderConnection();
  }
  renderConnection() {
    return b`
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
                    ${this.connecting ? b`<span class="activity" aria-hidden="true"></span>Connecting` : "Connect"}
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
  renderShell() {
    return b`
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
            ${this.directoryState ? b`<agent-directory
                  .state=${this.directoryState}
                  @agent-select=${this.handleAgentSelect}
                  @agent-query=${this.handleAgentQuery}
                  @agent-color=${this.handleAgentColor}
                ></agent-directory>` : A}
          </aside>

          <main id="agent-workspace" class="agent-workspace" aria-label="Agent workspace">
            <div class="workspace-header">
              <span class="workspace-kicker">
                Workspace / ${this.directoryState?.selectedAgent?.label ?? "no selection"}
              </span>
              <span class="header-rule"></span>
            </div>
            ${this.directoryState?.selectedAgent ? this.renderAgentWorkspace() : b`
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
  renderAgentWorkspace() {
    const agent = this.directoryState?.selectedAgent;
    return b`
      <div class="workspace-body">
        <session-create
          .agentId=${agent?.id}
          .features=${this.features}
          .state=${this.sessionState ?? { status: "idle", advancedOpen: false }}
          @session-create=${this.handleSessionCreate}
          @session-advanced=${this.handleSessionAdvanced}
        ></session-create>
        <div id="workspace-tabs" class="workspace-tabs" role="tablist" aria-label="Agent sections">
          ${["overview", "persona"].map(
      (tab) => b`
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
            `
    )}
        </div>
        ${this.workspaceTab === "overview" ? b`<agent-overview
              .agent=${agent}
              .features=${this.features}
              .saving=${this.directoryState?.updatingAgentId === agent?.id}
              .errorText=${this.directoryState?.updateErrorText}
              @agent-update=${this.handleAgentUpdate}
            ></agent-overview>` : b`<agent-persona
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
  agentCountLabel() {
    if (this.directoryState?.status !== "ready") return "No agents loaded";
    const count = this.directoryState.totalCount;
    return count === 1 ? "1 agent" : `${count} agents`;
  }
  startDirectory(connectionId, features) {
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
  stopDirectory() {
    this.unsubscribeSessions?.();
    this.unsubscribeSessions = void 0;
    this.sessions = void 0;
    this.sessionState = void 0;
    this.unsubscribeDirectory?.();
    this.unsubscribeDirectory = void 0;
    this.directory = void 0;
    this.directoryState = void 0;
    this.unsubscribePersona?.();
    this.unsubscribePersona = void 0;
    this.persona = void 0;
    this.personaState = void 0;
    this.workspaceTab = "overview";
  }
  updated() {
    this.syncPersona();
  }
  /** Loads persona files only once the operator actually opens the Persona tab. */
  syncPersona() {
    const agentId = this.directoryState?.selectedId;
    const persona = this.persona;
    if (this.workspaceTab !== "persona" || !agentId || !persona || this.personaSyncing) return;
    if (this.personaState?.agentId !== agentId) {
      this.personaSyncing = true;
      void persona.selectAgent(agentId).then(() => this.selectFirstPersonaFile()).finally(() => {
        this.personaSyncing = false;
      });
      return;
    }
    void this.selectFirstPersonaFile();
  }
  async selectFirstPersonaFile() {
    const state = this.persona?.getState();
    if (!this.persona || !state || state.status !== "ready" || state.selected) return;
    await this.persona.selectFile(PERSONA_FILES[0]);
  }
  isCurrentLifecycle(generation) {
    return this.mounted && generation === this.lifecycleGeneration;
  }
  clearLocalConnection() {
    this.stopDirectory();
    this.connectionId = void 0;
    this.features = void 0;
    this.drawerOpen = false;
    this.connecting = false;
    this.disconnecting = false;
    this.errorText = "";
    this.statusText = "Disconnected. Gateway token required";
  }
  disconnectConnection(connectionId, options) {
    const existing = this.disconnects.get(connectionId);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => options ? this.api.disconnect(connectionId, options) : this.api.disconnect(connectionId)).catch(() => void 0).finally(() => {
      this.disconnects.delete(connectionId);
    });
    this.disconnects.set(connectionId, operation);
    return operation;
  }
};
_AgentStudioApp.properties = {
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
  workspaceTab: { state: true }
};
let AgentStudioApp = _AgentStudioApp;
if (!customElements.get("agent-studio-app")) {
  customElements.define("agent-studio-app", AgentStudioApp);
}
const mount = document.querySelector("#agent-studio-root");
if (!mount) throw new Error("Agent Studio mount point unavailable");
const app = document.createElement("agent-studio-app");
window.addEventListener("pagehide", () => app.teardown());
window.addEventListener("pageshow", () => app.reactivate());
mount.replaceChildren(app);
