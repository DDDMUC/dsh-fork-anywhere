// dsh-fork-anywhere - client-half tests.
//
// The browser half is a classic client bundle, so the test drives it the way the
// loader does: capture the factory through `window.__ModuleLoader__.load`, then
// drive the reconciler on a micro-DOM that implements exactly the DOM calls this
// plugin makes (no jsdom in this workspace).
//
// Two properties are load-bearing here and both are about things that went wrong
// in real sessions, so both are asserted on counters rather than pixels:
//
//   * COST - 0.1.0 froze a 4000-event window by rescanning every row per token.
//   * CUT  - forking AT a prompt leaves its Turn open, so the Host closes it with
//            a synthetic `forked` end and the child opens on an empty "completed"
//            turn. The cut is the previous Turn's end.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

// --- micro DOM -----------------------------------------------------------------

/** The selectors this plugin actually queries. */
function matches(element, selector) {
  if (/^[a-z][\w-]*$/.test(selector)) return element.tag === selector
  let found = /^\[([a-z-]+)\]$/.exec(selector)
  if (found !== null) return element.attrs.has(found[1])
  found = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector)
  if (found !== null) return element.attrs.get(found[1]) === found[2]
  found = /^\[class\*="([^"]*)"\]$/.exec(selector)
  if (found !== null) return String(element.className || '').includes(found[1])
  found = /^([a-z][\w-]*)\[([a-z-]+)="([^"]*)"\]$/.exec(selector)
  if (found !== null) return element.tag === found[1] && element.attrs.get(found[2]) === found[3]
  found = /^\.([a-zA-Z][\w-]*)$/.exec(selector)
  if (found !== null) return String(element.className || '').split(/\s+/).includes(found[1])
  throw new Error('micro DOM: unsupported selector ' + selector)
}

function walk(element, out) {
  for (const child of element.children) {
    out.push(child)
    walk(child, out)
  }
  return out
}

function makeElement(tag, attrs = {}, className = '') {
  const element = {
    tag,
    nodeType: 1,
    attrs: new Map(Object.entries(attrs)),
    children: [],
    parentElement: null,
    dataset: {},
    append(...nodes) {
      for (const node of nodes) this.appendChild(node)
    },
    get previousElementSibling() {
      const parent = this.parentElement
      if (parent === null) return null
      const index = parent.children.indexOf(this)
      return index > 0 ? parent.children[index - 1] : null
    },
    listeners: new Map(),
    className,
    insertCalls: 0,
    innerHTML: '',
    textContent: '',
    style: {},
    id: attrs.id ?? '',
    connectedRoot: false,
    setAttribute(key, value) {
      element.attrs.set(key, String(value))
    },
    getAttribute(key) {
      return element.attrs.has(key) ? element.attrs.get(key) : null
    },
    hasAttribute(key) {
      return element.attrs.has(key)
    },
    removeAttribute(key) {
      element.attrs.delete(key)
    },
    appendChild(node) {
      node.remove()
      node.parentElement = element
      element.children.push(node)
      return node
    },
    insertBefore(node, reference) {
      element.insertCalls += 1
      node.remove()
      node.parentElement = element
      if (reference === null || reference === undefined) {
        element.children.push(node)
        return node
      }
      const index = element.children.indexOf(reference)
      if (index < 0) element.children.push(node)
      else element.children.splice(index, 0, node)
      return node
    },
    remove() {
      if (element.parentElement !== null) {
        const siblings = element.parentElement.children
        const index = siblings.indexOf(element)
        if (index >= 0) siblings.splice(index, 1)
        element.parentElement = null
      }
    },
    addEventListener(type, listener) {
      const list = element.listeners.get(type) ?? []
      list.push(listener)
      element.listeners.set(type, list)
    },
    dispatch(type) {
      const event = {
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true
        },
        stopPropagation() {
          this.stopped = true
        },
      }
      for (const listener of element.listeners.get(type) ?? []) listener(event)
      return event
    },
    // A laid-out element occupies space; tests can hide one explicitly.
    getClientRects() {
      // A hidden ancestor removes layout from everything inside it, as in a browser.
      for (let node = this; node !== null && node !== undefined; node = node.parentElement) {
        if (node.hidden === true) return []
      }
      return [{ x: 0, y: 0, width: 10, height: 10 }]
    },
    get isConnected() {
      let current = element
      while (current !== null && current !== undefined) {
        if (current.connectedRoot === true) return true
        current = current.parentElement
      }
      return false
    },
    get childElementCount() {
      return element.children.length
    },
    get previousSibling() {
      const parent = element.parentElement
      if (parent === null) return null
      const index = parent.children.indexOf(element)
      return index > 0 ? parent.children[index - 1] : null
    },
    get nextSibling() {
      const parent = element.parentElement
      if (parent === null) return null
      const index = parent.children.indexOf(element)
      return index >= 0 && index < parent.children.length - 1 ? parent.children[index + 1] : null
    },
    querySelectorAll(selector) {
      return walk(element, []).filter((candidate) => matches(candidate, selector))
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] ?? null
    },
  }
  return element
}

/**
 * A document whose chat column is `<div data-chat-flow>`.
 * The flow root is what the plugin watches, so tests exercise the scoped
 * observer rather than the whole body.
 */
function makeEnvironment() {
  const body = makeElement('body')
  body.connectedRoot = true
  const head = makeElement('head')
  head.connectedRoot = true
  const flow = makeElement('div', { 'data-chat-flow': '' })
  body.appendChild(flow)
  const doc = {
    body,
    head,
    flow,
    createElement: (tag) => makeElement(tag),
    getElementById: () => null,
    querySelector(selector) {
      // Only what is still in the document counts, exactly like the browser:
      // a removed column must not keep answering.
      if (matches(body, selector)) return body
      return body.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector)
    },
  }
  return doc
}

function makePromptRow({ key = 'user:12', kind = 'user', turn = 1 } = {}) {
  const row = makeElement('div', {
    'data-chat-flow-key': key,
    'data-chat-flow-kind': kind,
    'data-chat-turn': String(turn),
  })
  row.appendChild(makeElement('div', { 'data-message-bubble': '' }))
  const bar = makeElement('div', {}, 'ZITbJG_actions')
  const copy = makeElement('button', {}, 'ZITbJG_action')
  copy.setAttribute('aria-label', 'copy')
  bar.appendChild(copy)
  row.appendChild(bar)
  return { row, bar, copy }
}

function makeAssistantRow(turn = 1) {
  const row = makeElement('div', {
    'data-chat-flow-key': 'assistant-step' + turn + ':1',
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-turn': String(turn),
  })
  const bar = makeElement('div', {}, 'ZITbJG_actions')
  bar.appendChild(makeElement('button', {}, 'ZITbJG_action'))
  row.appendChild(bar)
  return row
}

/**
 * A ChatSnapshot with the two shapes the plugin reads: `timeline.turns` and the
 * `legacy.turnEnds` fallback. `ends` maps a Turn number to its `turn/end` seq.
 */
function makeSnapshot({ nodes = new Map(), ends = new Map(), starts = new Map(), forked = [], legacyOnly = false } = {}) {
  const forkedSet = new Set(forked)
  const numbers = new Set([...ends.keys(), ...forkedSet])
  const turns = new Map()
  if (!legacyOnly) {
    for (const turn of numbers) {
      const seq = ends.has(turn) ? ends.get(turn) : turn * 10
      // The turn record the chat snapshot exposes IS the raw `turn/end` event.
      const end = forkedSet.has(turn) ? { seq, time: 0, data: { reason: { kind: 'forked' } } } : { seq, time: 0, data: { reason: { kind: 'completed' } } }
      const startSeq = starts.has(turn) ? starts.get(turn) : seq - 100
      turns.set(turn, { turn, start: { seq: startSeq, time: 0 }, end })
    }
  }
  return {
    nodes,
    order: [...nodes.keys()],
    timeline: { turnOrder: [...numbers], turns },
    legacy: { turnEnds: new Map(ends) },
  }
}

/** One compaction card row (`compaction` automatic, `manual-compaction` for /compact). */
function makeCompactionRow({ key = 'compaction:7', kind = 'compaction', turn = 2 } = {}) {
  const row = makeElement('div', { 'data-chat-flow-key': key, 'data-chat-flow-kind': kind, 'data-chat-turn': String(turn) })
  row.appendChild(makeElement('div', { 'data-compaction-card': '' }))
  return row
}

/** The checkpoint marker both compaction node kinds carry. */
function checkpoint(seq, extra = {}) {
  return { seq, time: 1794300000000, summary: '压缩摘要正文', shadowedItemCount: 12, shadowedTokenCount: 3400, ...extra }
}

/** The Turn-process header the Host renders above a settled Turn. */
function makeTurnProcessStrip(turn) {
  const strip = makeElement('button', { 'data-turn-process': String(turn) }, 'gTO55a_root')
  strip.appendChild(makeElement('span', {}, 'gTO55a_label'))
  return strip
}

// --- harness -------------------------------------------------------------------

const warnings = []
const sandbox = {
  console: {
    // Every swallowed error in the plugin surfaces here: a silently failing
    // decoration is indistinguishable from "the plugin is not installed".
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    info: () => {},
    log: () => {},
    error: (...args) => warnings.push(args.map(String).join(' ')),
  },
  // Short timers run (the reconciler's frame, the seat's flush); long ones are
  // dropped, because the vendored row arms a timer for local midnight and a live
  // handle would keep the test process alive for hours.
  setTimeout: (fn, ms) => (Number(ms) > 1000 ? 0 : setTimeout(fn, ms)),
  clearTimeout: (id) => clearTimeout(id),
}
sandbox.__copied = []
sandbox.navigator = {
  clipboard: {
    writeText(text) {
      sandbox.__copied.push(text)
      return Promise.resolve()
    },
  },
}
sandbox.__effects = []
sandbox.require = (id) => {
  if (id === 'react') {
    return {
      // Effects run where they are declared, synchronously, so the test can
      // observe exactly what a mount would do without a renderer.
      useEffect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') sandbox.__effects.push(cleanup)
      },
      useMemo: (factory) => factory(),
      useCallback: (callback) => callback,
      useLayoutEffect: (callback) => {
        const cleanup = callback()
        if (typeof cleanup === 'function') sandbox.__effects.push(cleanup)
      },
      useRef(initial) {
        return { current: initial }
      },
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      memo: (component) => component,
      createElement(type, props, ...children) {
        return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) }
      },
    }
  }
  if (id === 'react-dom') return { createPortal: (element) => element }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    // The vendored compaction row imports four icons; a stub keeps its module
    // loadable without React.
    const icon = () => null
    return { IconBranchOutlineRegular: icon, IconCopyOutlineRegular: icon, IconCheckOutlineRegular: icon, IconDatabaseOutlineRegular: icon }
  }
  throw new Error('unexpected require: ' + id)
}
let captured = null
sandbox.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}
sandbox.globalThis = sandbox
// The reference row hides itself with `opacity: 0` until hover; the plugin has to
// tell that apart from a painted row, so the sandbox exposes computed styles.
sandbox.getComputedStyle = (element) => ({
  opacity: element === null || element === undefined ? '1' : String(element.computedOpacity ?? '1'),
  visibility: element === null || element === undefined ? 'visible' : String(element.computedVisibility ?? 'visible'),
})
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox)

assert.equal(captured.id, 'dsh-fork-anywhere', 'the bundle registers one module id')
const plugin = captured.factory((id) => sandbox.require(id))
const api = plugin.__dsfa

/** A reconciler whose frames and observer the test drives by hand. */
function makeReconciler({ doc, sessionId = 'session-source', snapshot = makeSnapshot(), fork = () => {}, useUsage = null, useBefore = null, fallbackCut = null, info = null, sessions = null, t = (key) => key } = {}) {
  const frames = new Map()
  let nextFrame = 1
  const observers = []
  const live = {
    snapshot,
    t,
    fork,
    usageFor: useUsage === null ? () => null : useUsage,
    beforeFor: useBefore === null ? () => null : useBefore,
    fallbackCut: fallbackCut === null ? undefined : fallbackCut,
    infoFor: info === null ? undefined : () => info,
    sessions: sessions === null ? undefined : () => sessions,
    usageFor: useUsage === null ? null : () => useUsage(),
  }
  const reconciler = api.createReconciler({
    doc,
    sessionId,
    live,
    frame(callback) {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    },
    cancel(id) {
      frames.delete(id)
    },
    Observer: class {
      constructor(callback) {
        this.callback = callback
        this.roots = []
        observers.push(this)
      }
      observe(root) {
        this.roots.push(root)
      }
      disconnect() {
        this.roots = []
      }
    },
    now: () => 0,
  })
  return {
    reconciler,
    live,
    observers,
    /** Run every queued frame, including frames those frames queue. */
    flushFrames() {
      for (let guard = 0; guard < 32 && frames.size > 0; guard += 1) {
        const batch = [...frames.values()]
        frames.clear()
        for (const callback of batch) callback()
      }
    },
    pendingFrames: () => frames.size,
    /** Deliver one mutation record to the live observer. */
    emit(record) {
      const observer = observers.at(-1)
      assert.notEqual(observer, undefined, 'the reconciler started an observer')
      observer.callback([record])
    },
  }
}

function promptNode(seq) {
  return { kind: 'user', data: { seq } }
}

// --- tests ---------------------------------------------------------------------

test('seqOfNode reads the durable prompt seq and nothing else', () => {
  assert.equal(api.seqOfNode({ kind: 'user', data: { seq: 12 } }), 12)
  assert.equal(api.seqOfNode({ kind: 'steering', data: { seq: 0 } }), 0)
  assert.equal(api.seqOfNode({ kind: 'assistant-step', data: { seq: 12 } }), null)
  assert.equal(api.seqOfNode({ kind: 'user', data: { seq: -1 } }), null)
  assert.equal(api.seqOfNode({ kind: 'user', data: { seq: 1.5 } }), null)
  assert.equal(api.seqOfNode({ kind: 'user' }), null)
  assert.equal(api.seqOfNode(null), null)
})

test('nodeOf resolves composite keys the way grouped rows spell them', () => {
  const node = { kind: 'user', data: { seq: 3 } }
  const nodes = new Map([['user:3', node]])
  assert.equal(api.nodeOf(nodes, 'user:3'), node)
  assert.equal(api.nodeOf(nodes, '["user:3","response"]'), node)
  assert.equal(api.nodeOf(nodes, '["turn-tail:9"]'), null)
  assert.equal(api.nodeOf(nodes, ''), null)
})

test('点哪里，哪里就是尾部：切点就是被点的那条消息', () => {
  const doc = makeEnvironment()
  const prompt = makePromptRow({ turn: 2 })
  doc.flow.appendChild(prompt.row)
  const calls = []
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:12', promptNode(12)]]), ends: new Map([[0, 9], [2, 30]]) }),
    fork: (sessionId, seq) => calls.push([sessionId, seq]),
  })
  harness.reconciler.start()
  harness.flushFrames()

  const hosts = prompt.row.querySelectorAll('[data-dsfa-host="1"]')
  assert.equal(hosts.length, 1, 'exactly one injected host')
  assert.equal(hosts[0].parentElement, prompt.bar)
  assert.equal(hosts[0].previousSibling, prompt.copy, 'anchored after the copy button')
  // The message is seq 12 even though its Turn closes at 30: the child ends at
  // the clicked row, and later events of the same Turn stay behind.
  assert.equal(hosts[0].getAttribute('data-dsfa-seq'), '12')
  assert.equal(hosts[0].querySelector('button').getAttribute('aria-label'), 'action.fork')

  hosts[0].querySelector('button').dispatch('click')
  assert.deepEqual(calls, [['session-source', 12]])
})

test('a prompt in the running Turn still forks at itself', () => {
  const doc = makeEnvironment()
  const prompt = makePromptRow({ key: 'user:70', turn: 4 })
  doc.flow.appendChild(prompt.row)
  const calls = []
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:70', promptNode(70)]]), ends: new Map([[3, 60]]) }),
    fork: (sessionId, seq) => calls.push(seq),
  })
  harness.reconciler.start()
  harness.flushFrames()
  // No answer exists yet, so the cut is the message itself and the Host closes
  // the half Turn; `applyForkTails` hides that leftover in the child.
  const host = prompt.row.querySelector('[data-dsfa-host="1"]')
  assert.equal(host.getAttribute('data-dsfa-seq'), '70')
  host.querySelector('button').dispatch('click')
  assert.deepEqual(calls, [70])
})

test('the first prompt of a session is its own tail', () => {
  const doc = makeEnvironment()
  const first = makePromptRow({ key: 'user:1', turn: 0 })
  doc.flow.appendChild(first.row)
  const calls = []
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:1', promptNode(1)]]), ends: new Map([[0, 7]]) }),
    fork: (sessionId, seq) => calls.push(seq),
  })
  harness.reconciler.start()
  harness.flushFrames()
  first.row.querySelector('[data-dsfa-host="1"]').querySelector('button').dispatch('click')
  assert.deepEqual(calls, [1])
})

test('a second pass visits no rows at all (the 0.1.0 freeze)', () => {
  const doc = makeEnvironment()
  const prompt = makePromptRow({ turn: 1 })
  doc.flow.appendChild(prompt.row)
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:12', promptNode(12)]]), ends: new Map([[0, 9]]) }),
  })
  harness.reconciler.start()
  harness.flushFrames()
  const afterMount = harness.reconciler.stats()
  assert.equal(afterMount.rows, 1, 'the mount pass visits the one row')

  // Streamed output: the store changes and React re-renders, but no row is added.
  for (let index = 0; index < 200; index += 1) {
    harness.live.snapshot = harness.live.snapshot
    harness.emit({ type: 'childList', addedNodes: [makeTextNode('tok' + index)] })
    harness.flushFrames()
  }
  const afterStream = harness.reconciler.stats()
  assert.equal(afterStream.passes, afterMount.passes, 'no pass ran for a text node')
  assert.equal(afterStream.rows, afterMount.rows, 'no row was visited')
  assert.equal(harness.pendingFrames(), 0)
})

test('one appended row costs one row visit, not a full rescan', () => {
  const doc = makeEnvironment()
  const first = makePromptRow({ key: 'user:1', turn: 1 })
  doc.flow.appendChild(first.row)
  const nodes = new Map([['user:1', promptNode(1)]])
  const ends = new Map([[0, 9]])
  const harness = makeReconciler({ doc, snapshot: makeSnapshot({ nodes, ends }) })
  harness.reconciler.start()
  harness.flushFrames()
  const mounted = harness.reconciler.stats()
  assert.equal(mounted.rows, 1)

  const second = makePromptRow({ key: 'user:2', turn: 2 })
  doc.flow.appendChild(second.row)
  nodes.set('user:2', promptNode(2))
  ends.set(1, 30)
  harness.live.snapshot = makeSnapshot({ nodes, ends })
  harness.emit({ type: 'childList', addedNodes: [second.row] })
  harness.flushFrames()
  const after = harness.reconciler.stats()
  assert.equal(after.passes, mounted.passes + 1)
  assert.equal(after.rows, mounted.rows + 1, 'only the new row is visited')
})

test('mutations inside one frame coalesce into a single pass', () => {
  const doc = makeEnvironment()
  const harness = makeReconciler({ doc })
  harness.reconciler.start()
  harness.flushFrames()
  const before = harness.reconciler.stats().passes

  for (let index = 0; index < 50; index += 1) {
    const row = makePromptRow({ key: 'user:' + (100 + index) })
    doc.flow.appendChild(row.row)
    harness.emit({ type: 'childList', addedNodes: [row.row] })
  }
  assert.equal(harness.pendingFrames(), 1, 'fifty mutations booked one frame')
  harness.flushFrames()
  assert.equal(harness.reconciler.stats().passes, before + 1)
})

test('the plugin does not wake itself with its own insertion', () => {
  const doc = makeEnvironment()
  const prompt = makePromptRow({ turn: 1 })
  doc.flow.appendChild(prompt.row)
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:12', promptNode(12)]]), ends: new Map([[0, 9]]) }),
  })
  harness.reconciler.start()
  harness.flushFrames()
  const host = prompt.row.querySelector('[data-dsfa-host="1"]')
  const before = harness.reconciler.stats().passes

  // What the observer would receive from the plugin's own insertBefore.
  harness.emit({ type: 'childList', addedNodes: [host] })
  assert.equal(harness.pendingFrames(), 0, 'the own node schedules nothing')
  assert.equal(harness.reconciler.stats().passes, before)
})

test('a replaced action strip is re-decorated on the next pass', () => {
  const doc = makeEnvironment()
  const prompt = makePromptRow({ turn: 1 })
  doc.flow.appendChild(prompt.row)
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:12', promptNode(12)]]), ends: new Map([[0, 9]]) }),
  })
  harness.reconciler.start()
  harness.flushFrames()
  assert.equal(prompt.row.querySelectorAll('[data-dsfa-host="1"]').length, 1)

  // React rebuilds the row's children: the old strip (and the injected host) goes.
  for (const child of [...prompt.row.children]) child.remove()
  const bar = makeElement('div', {}, 'ZITbJG_actions')
  const copy = makeElement('button', {}, 'ZITbJG_action')
  bar.appendChild(copy)
  prompt.row.appendChild(bar)

  harness.emit({ type: 'childList', addedNodes: [bar] })
  harness.flushFrames()
  const hosts = prompt.row.querySelectorAll('[data-dsfa-host="1"]')
  assert.equal(hosts.length, 1, 'the strip is decorated again')
  assert.equal(hosts[0].parentElement, bar)
})

test('the observer watches the chat column, not the whole document', () => {
  const doc = makeEnvironment()
  const harness = makeReconciler({ doc })
  harness.reconciler.start()
  harness.flushFrames()
  const observer = harness.observers.at(-1)
  assert.deepEqual(observer.roots, [doc.flow])
})

test('a bar without any button still receives the action, once', () => {
  const doc = makeEnvironment()
  const row = makeElement('div', { 'data-chat-flow-key': 'user:5', 'data-chat-flow-kind': 'user', 'data-chat-turn': '1' })
  const bar = makeElement('div', {}, 'ZITbJG_actions')
  row.appendChild(bar)
  doc.flow.appendChild(row)
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:5', promptNode(5)]]), ends: new Map([[0, 4]]) }),
  })
  harness.reconciler.start()
  harness.flushFrames()
  harness.emit({ type: 'childList', addedNodes: [row] })
  harness.flushFrames()
  assert.equal(bar.querySelectorAll('[data-dsfa-host="1"]').length, 1)
  // A self-anchor would move the node onto itself, and every move wakes the observer.
  assert.equal(bar.insertCalls, 1, 'one insertion, then nothing')
})

test('a steering row is forkable too', () => {
  const doc = makeEnvironment()
  const steering = makePromptRow({ key: 'steering:7', kind: 'steering', turn: 5 })
  doc.flow.appendChild(steering.row)
  const calls = []
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['steering:7', { kind: 'steering', data: { seq: 7 } }]]), ends: new Map([[4, 40]]) }),
    fork: (sessionId, seq) => calls.push(seq),
  })
  harness.reconciler.start()
  harness.flushFrames()
  steering.row.querySelector('[data-dsfa-host="1"]').querySelector('button').dispatch('click')
  assert.deepEqual(calls, [7])
})

test('latestCompactionCut reads the newest compaction out of the event window', () => {
  const event = (seq, type) => ({ type: 'event', event: { seq, type, data: {} } })
  const sessions = {
    binding() {
      return {
        eventSource: {
          getSnapshot: () => ({ entries: [event(40, 'compaction/start'), event(41, 'compaction/summary'), event(42, 'compaction/end')], revision: 1 }),
        },
      }
    },
  }
  assert.equal(api.latestCompactionCut(sessions, 'session-source'), 42)
  assert.equal(api.latestCompactionCut(null, 'session-source'), null)

  const summaryOnly = {
    binding: () => ({ eventSource: { getSnapshot: () => ({ entries: [event(41, 'compaction/summary')], revision: 1 }) } }),
  }
  assert.equal(api.latestCompactionCut(summaryOnly, 'session-source'), 41, 'a summary without an end still cuts after it')
})

test('a row without a turn number forks at its own message, never at Turn 0', () => {
  const doc = makeEnvironment()
  // No data-chat-turn: Number(null) would be 0 and would cut at the first Turn.
  const row = makeElement('div', { 'data-chat-flow-key': 'user:70', 'data-chat-flow-kind': 'user' })
  row.appendChild(makeElement('div', { 'data-message-bubble': '' }))
  const bar = makeElement('div', {}, 'ZITbJG_actions')
  bar.appendChild(makeElement('button', {}, 'ZITbJG_action'))
  row.appendChild(bar)
  doc.flow.appendChild(row)

  const calls = []
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:70', promptNode(70)]]), ends: new Map([[0, 9], [1, 30]]) }),
    fork: (sessionId, seq) => calls.push(seq),
  })
  harness.reconciler.start()
  harness.flushFrames()
  const host = row.querySelector('[data-dsfa-host="1"]')
  assert.notEqual(host, null)
  assert.equal(host.getAttribute('data-dsfa-seq'), '70', 'the message itself, not Turn 0\'s end')
  host.querySelector('button').dispatch('click')
  assert.deepEqual(calls, [70])
})

test('a large transcript: one mount scan, then delta-only work', () => {
  const doc = makeEnvironment()
  const nodes = new Map()
  const ends = new Map()
  const ROWS = 1200
  for (let index = 0; index < ROWS; index += 1) {
    const prompt = makePromptRow({ key: 'user:' + index, turn: index + 1 })
    doc.flow.appendChild(prompt.row)
    doc.flow.appendChild(makeAssistantRow(index + 1))
    nodes.set('user:' + index, promptNode(index))
    ends.set(index, index * 10)
  }
  const harness = makeReconciler({ doc, snapshot: makeSnapshot({ nodes, ends }) })
  harness.reconciler.start()
  harness.flushFrames()
  const mounted = harness.reconciler.stats()
  // Counters, not wall time: this machine's load swings the clock far more than
  // the code does, and a single mount pass over 1200 prompts is the real claim.
  assert.equal(mounted.passes, 1, 'the mount is one pass')
  assert.equal(mounted.rows, ROWS * 2, 'the mount pass walks the transcript once')
  assert.equal(doc.flow.querySelectorAll('[data-dsfa-host="1"]').length, ROWS)

  // 300 streamed updates: the store churns, no row changes.
  const before = harness.reconciler.stats()
  for (let tick = 0; tick < 300; tick += 1) {
    harness.live.snapshot = makeSnapshot({ nodes, ends })
    harness.emit({ type: 'childList', addedNodes: [makeTextNode('tick' + tick)] })
    harness.flushFrames()
  }
  const after = harness.reconciler.stats()
  assert.equal(after.passes, before.passes, 'streaming never triggers a pass')
  assert.equal(after.rows, before.rows, 'streaming never visits a row')
})

test('a remounted chat column is picked up by the watchdog', () => {
  const doc = makeEnvironment()
  const harness = makeReconciler({
    doc,
    snapshot: makeSnapshot({ nodes: new Map([['user:12', promptNode(12)]]), ends: new Map([[1, 30]]) }),
  })
  harness.reconciler.start()
  harness.flushFrames()

  // The Chat view unmounts and remounts its flow container: a fresh column holds
  // the same rows, and the observer has to follow it.
  const replacement = makeElement('div', { 'data-chat-flow': '' })
  const prompt = makePromptRow({ turn: 2 })
  replacement.appendChild(prompt.row)
  doc.flow.remove()
  doc.body.appendChild(replacement)
  doc.flow = replacement

  harness.reconciler.revalidate()
  harness.flushFrames()

  assert.notEqual(replacement.querySelector('[data-dsfa-host="1"]'), null, 'the new column is decorated')
})

test('apply publishes a status record that can be read off disk', () => {
  const stored = new Map()
  const sandboxStore = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => {
      stored.set(key, String(value))
    },
  }
  const savedLocal = sandbox.localStorage
  sandbox.localStorage = sandboxStore
  const seats = []
  const services = {
    get(key) {
      if (key === 'slots') return { inject: (name, callback) => callback(), register: (options, component) => { seats.push({ options, component }); return () => {} } }
      if (key === 'locale') return { register: () => () => {}, bind: () => (k) => k }
      if (key === 'uiConversation') {
        return {
          events: {
            register: () => () => {},
          },
        }
      }
      return undefined
    },
  }
  const ctx = {
    get: (key) => services.get(key),
    get slots() { return services.get('slots') },
    get locale() { return services.get('locale') },
    get uiConversation() { return services.get('uiConversation') },
    effect: (callback) => callback(),
  }
  const savedDoc = sandbox.document
  sandbox.document = makeEnvironment()
  try {
    const fresh = captured.factory((id) => sandbox.require(id))
    fresh.apply(ctx)
  } finally {
    sandbox.document = savedDoc
    sandbox.localStorage = savedLocal
  }
  const raw = stored.get('dsh-fork-anywhere/status')
  assert.equal(typeof raw, 'string', 'the status key is written')
  const status = JSON.parse(raw)
  assert.equal(status.version, api.PLUGIN_VERSION)
  assert.equal(status.loaded, true)
  assert.equal(status.loaded, true)
  assert.equal(status.services.uiConversation, true)
})

test('a fork child reports the inputs it inherited but can never deliver', () => {
  const events = [
    { seq: 7684, type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: '你不要去分析什么模式什么情况' }] }] } },
    { seq: 7691, type: 'compaction/start', data: { compactionId: 'c1' } },
    { seq: 7696, type: 'compaction/end', data: { compactionId: 'c1' } },
    { seq: 7697, type: 'session/end-seed', data: { inherited: true } },
  ]
  const sessions = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: events.map((event) => ({ event })) }) } }) }
  assert.equal(JSON.stringify(api.staleInputTexts(sessions, 'session-x')), JSON.stringify(['你不要去分析什么模式什么情况']))

  // Delivered before the cut: the input is history, not stale.
  const delivered = events.concat([{ seq: 7694, type: 'user/message', data: { content: [{ type: 'text', text: '你不要去分析什么模式什么情况' }] } }])
  const deliveredSessions = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: delivered.map((event) => ({ event })) }) } }) }
  assert.equal(JSON.stringify(api.staleInputTexts(deliveredSessions, 'session-x')), '[]')

  // Not a fork: nothing is inherited, so nothing is stale.
  const plain = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: events.slice(0, 3).map((event) => ({ event })) }) } }) }
  assert.equal(JSON.stringify(api.staleInputTexts(plain, 'session-x')), '[]')
})

test('a row backed by a transcript node is never treated as a stale input', () => {
  const doc = makeEnvironment()
  const durable = makeElement('div', { 'data-chat-flow-key': 'user:9', 'data-chat-node-key': 'user:9' })
  durable.textContent = '还在，没有修好'
  doc.flow.appendChild(durable)
  const hidden = api.hideStaleInputs(doc.flow, ['还在，没有修好'])
  assert.equal(hidden, 0, 'a real message survives')
})

test('the stale input row is hidden by its exact text only', () => {
  const doc = makeEnvironment()
  const exact = makeElement('div', { 'data-chat-flow-key': 'input:1' })
  exact.textContent = '你不要去分析什么模式什么情况'
  const containing = makeElement('div', { 'data-chat-flow-key': 'user:2' })
  containing.textContent = '？\n\n> 标准模式：app:web-surface 你不要去分析什么模式什么情况'
  doc.flow.appendChild(exact)
  doc.flow.appendChild(containing)
  const hidden = api.hideStaleInputs(doc.flow, ['你不要去分析什么模式什么情况'])
  assert.equal(hidden, 1)
  assert.equal(exact.getAttribute('data-dsfa-stale'), '1')
  assert.equal(containing.getAttribute('data-dsfa-stale'), null, 'a message that merely contains it is untouched')
})

test('an empty forked Turn is hidden, a forked Turn with rows is kept', () => {
  const doc = makeEnvironment()
  const emptyRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  const emptyHeader = makeElement('button', { 'data-turn-process': '3' })
  emptyHeader.textContent = '已完成，用时 1 秒'
  emptyRow.appendChild(emptyHeader)
  emptyRow.textContent = '已完成，用时 1 秒'
  const fullRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:4', 'data-chat-flow-kind': 'turn-process' })
  const fullHeader = makeElement('button', { 'data-turn-process': '4' })
  fullHeader.textContent = '执行了命令'
  fullRow.appendChild(fullHeader)
  fullRow.textContent = '执行了命令上下文已压缩'
  fullRow.appendChild(makeElement('div', { 'data-chat-flow-key': 'compaction:aa', 'data-chat-node-key': 'compaction:aa' }, '上下文已压缩'))
  doc.flow.appendChild(emptyRow)
  doc.flow.appendChild(fullRow)

  const hidden = api.hideEmptyForkedTurns(doc.flow, [3, 4])
  assert.equal(hidden, 1, 'only the empty one')
  assert.equal(emptyRow.getAttribute('data-dsfa-empty-turn'), '1')
  assert.equal(fullRow.getAttribute('data-dsfa-empty-turn'), null, 'a compacted Turn keeps its header')
})

test('a fork cut on a user message reports the forked Turn, a fork cut on a compaction does not', () => {
  const base = [
    { event: { seq: 10, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { seq: 20, type: 'turn/end', data: { turn: 2, reason: { kind: 'forked' } } } },
  ]
  const fromMessage = base.concat([
    { event: { seq: 30, type: 'user/message', data: { content: [] } } },
    { event: { seq: 31, type: 'session/end-seed', data: { inherited: true } } },
  ])
  const messageSessions = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: fromMessage }) } }) }
  assert.equal(JSON.stringify(api.forkedTurnNumbers(messageSessions, 's')), '[2]', 'the empty tail is hidden')

  const fromCompaction = base.concat([
    { event: { seq: 30, type: 'compaction/end', data: { compactionId: 'c1' } } },
    { event: { seq: 31, type: 'session/end-seed', data: { inherited: true } } },
  ])
  const compactionSessions = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: fromCompaction }) } }) }
  assert.equal(JSON.stringify(api.forkedTurnNumbers(compactionSessions, 's')), '[]', 'a compaction fork keeps everything')
})

test('a row that holds a compaction card is never treated as an empty Turn', () => {
  const doc = makeEnvironment()
  const row = makeElement('div', { 'data-chat-flow-key': 'turn-process:4', 'data-chat-flow-kind': 'turn-process' })
  row.appendChild(makeElement('button', { 'data-turn-process': '4' }))
  row.appendChild(makeElement('span', { 'data-compaction-icon': 'context' }))
  doc.flow.appendChild(row)
  assert.equal(api.hideEmptyForkedTurns(doc.flow, [4]), 0)
  assert.equal(row.getAttribute('data-dsfa-empty-turn'), null)
})

test('a stopped Turn puts the fork action inside its own tail container', () => {
  const doc = makeEnvironment()
  const headerRow = makeElement('div', {
    'data-chat-flow-key': 'turn-process:3',
    'data-chat-flow-kind': 'turn-process',
    'data-chat-turn': '3',
  })
  headerRow.appendChild(makeElement('button', { 'data-turn-process': '3' }))
  const tail = makeElement('div', { 'data-turn-tail': '3' })
  headerRow.appendChild(tail)
  doc.flow.appendChild(headerRow)

  const savedDoc = sandbox.document
  sandbox.document = doc
  const calls = []
  let mounted
  try {
    mounted = api.decorateDirtyTurns(doc.flow, [{ turn: 3, seq: 19 }], {
      t: (key) => key,
      fork: (sessionId, seq) => calls.push([sessionId, seq]),
      sessionId: 'session-source',
      doc,
    })
  } finally {
    sandbox.document = savedDoc
  }
  assert.equal(mounted, 1, 'the stopped Turn offers a fork')
  const host = tail.querySelector('[data-dsfa-dirty="1"]')
  assert.notEqual(host, null, 'inside the container the platform uses for its own action row')
  assert.equal(host.getAttribute('data-dsfa-seq'), '19', 'cut at the turn/end where it stopped')
  host.querySelector('button').dispatch('click')
  assert.equal(JSON.stringify(calls), JSON.stringify([['session-source', 19]]))
})

test('without that container the action still lands below the content, never under the title', () => {
  const doc = makeEnvironment()
  const headerRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  headerRow.appendChild(makeElement('button', { 'data-turn-process': '3' }))
  const content = makeElement('div', { 'data-chat-flow-key': 'step:3', 'data-chat-node-key': 'step:3' })
  headerRow.appendChild(content)
  doc.flow.appendChild(headerRow)

  const savedDoc = sandbox.document
  sandbox.document = doc
  let mounted
  try {
    mounted = api.decorateDirtyTurns(doc.flow, [{ turn: 3, seq: 19 }], { t: (k) => k, fork: () => {}, sessionId: 's', doc })
  } finally {
    sandbox.document = savedDoc
  }
  assert.equal(mounted, 1)
  const row = doc.flow.querySelector('.dsfa-dirty-row')
  assert.notEqual(row, null, 'a row of its own')
  assert.equal(row.previousElementSibling, content, 'placed after the last content row')
  assert.notEqual(row.parentElement, headerRow.parentElement.appendChild, 'not mixed into the header row')
})

test('a Turn whose tail already holds shipped actions gets no second button', () => {
  const doc = makeEnvironment()
  const headerRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  headerRow.appendChild(makeElement('button', { 'data-turn-process': '3' }))
  const tail = makeElement('div', { 'data-turn-tail': '3' })
  const shippedRow = makeElement('div', {}, 'MessageIconActions_module_css__actions')
  shippedRow.appendChild(makeElement('button', { 'aria-label': 'message.branch' }))
  tail.appendChild(shippedRow)
  headerRow.appendChild(tail)
  doc.flow.appendChild(headerRow)

  const savedDoc = sandbox.document
  sandbox.document = doc
  let mounted
  try {
    mounted = api.decorateDirtyTurns(doc.flow, [{ turn: 3, seq: 19 }], { t: (k) => k, fork: () => {}, sessionId: 's', doc })
  } finally {
    sandbox.document = savedDoc
  }
  assert.equal(mounted, 0, 'the platform already offers the action')
  assert.equal(tail.querySelector('[data-dsfa-dirty="1"]'), null)
})

test('a previously injected button is withdrawn once shipped actions appear', () => {
  const doc = makeEnvironment()
  const headerRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  const tail = makeElement('div', { 'data-turn-tail': '3' })
  const mine = makeElement('span', { 'data-dsfa-dirty': '1', 'data-dsfa-host': '1' })
  mine.appendChild(makeElement('button', {}))
  tail.appendChild(mine)
  headerRow.appendChild(tail)
  doc.flow.appendChild(headerRow)

  const savedDoc = sandbox.document
  sandbox.document = doc
  try {
    api.decorateDirtyTurns(doc.flow, [{ turn: 3, seq: 19 }], { t: (k) => k, fork: () => {}, sessionId: 's', doc })
  } finally {
    sandbox.document = savedDoc
  }
  assert.equal(tail.querySelector('[data-dsfa-dirty="1"]'), null, 'the old button is removed')
})

test('a disabled shipped branch button is hidden and ours takes its place', () => {
  const doc = makeEnvironment()
  const headerRow = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  headerRow.appendChild(makeElement('button', { 'data-turn-process': '3' }))
  const tail = makeElement('div', { 'data-turn-tail': '3' })
  const shippedRow = makeElement('div', {}, 'MessageIconActions_module_css__actions')
  const deadBranch = makeElement('button', { 'aria-label': 'message.branch', 'aria-disabled': 'true', 'data-unavailable': '' })
  shippedRow.appendChild(deadBranch)
  tail.appendChild(shippedRow)
  headerRow.appendChild(tail)
  doc.flow.appendChild(headerRow)

  const savedDoc = sandbox.document
  sandbox.document = doc
  let mounted
  try {
    mounted = api.decorateDirtyTurns(doc.flow, [{ turn: 3, seq: 19 }], { t: (k) => k, fork: () => {}, sessionId: 's', doc })
  } finally {
    sandbox.document = savedDoc
  }
  assert.equal(deadBranch.getAttribute('data-dsfa-hide-shipped'), '1', 'the dead button is hidden')
  assert.equal(mounted, 1, 'ours is injected so the action stays usable')
  assert.notEqual(tail.querySelector('[data-dsfa-dirty="1"]'), null)
})

test('only stopped or interrupted turns count as dirty', () => {
  const entries = [
    { event: { seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } } },
    { event: { seq: 11, type: 'turn/end', data: { turn: 3, reason: { kind: 'forked' } } } },
  ]
  const sessions = { binding: () => ({ eventSource: { getSnapshot: () => ({ entries }) } }) }
  assert.equal(JSON.stringify(api.dirtyTurnEnds(sessions, 'session-x')), JSON.stringify([{ turn: 2, seq: 9 }]))
})

test('the compaction node lands right after compaction/end', () => {
  const definition = api.compactionRowDefinition()
  const context = {
    key: 'node-1', id: 'c1',
    start: { event: { seq: 7691, type: 'compaction/start', data: { compactionId: 'c1' } }, location: { kind: 'turn', turn: { turn: 3 } } },
    matches: [
      { event: { seq: 7694, type: 'compaction/summary', time: 1794300000000, data: { compactionId: 'c1', summary: [{ type: 'text', text: '摘要' }], usage: { uncachedInputTokens: 3400, outputTokens: 812, cacheReadTokens: 7234 } } }, location: { kind: 'turn', turn: { turn: 3 } } },
      { event: { seq: 7696, type: 'compaction/end', time: 1794300000000, data: { compactionId: 'c1' } }, location: { kind: 'turn', turn: { turn: 3 } } },
    ],
    state: undefined,
  }
  let state
  for (const match of context.matches) state = definition.update({ ...context, state }, match)
  const node = definition.buildViewNode({ ...context, state })
  assert.equal(node.kind, 'dsh-fork-anywhere-compaction')
  assert.equal(node.anchorSeq, 7696.1, 'immediately after the end event')
  assert.equal(node.data.seq, 7696, 'the fork cut is compaction/end')
  assert.equal(node.data.summaryText, '摘要')
  assert.deepEqual(node.location, context.matches[1].location, '位置取 compaction/end 的匹配，不是起点')
  assert.equal(node.groupTree, undefined, 'no groupTree: a turn-level node splits the process group')
})

test('empty forked Turn is hidden even when its header carries a duration', () => {
  const doc = makeEnvironment()
  const row = makeElement('div', { 'data-chat-flow-key': 'turn-process:3', 'data-chat-flow-kind': 'turn-process' })
  const header = makeElement('button', { 'data-turn-process': '3' })
  header.textContent = '已完成'
  row.appendChild(header)
  row.textContent = '已完成，用时 1 秒'
  doc.flow.appendChild(row)

  const hidden = api.hideEmptyForkedTurns(doc.flow, [3])
  assert.equal(hidden, 1, 'no child rows: it is empty')
  assert.equal(row.getAttribute('data-dsfa-empty-turn'), '1')
})

test('a forked Turn that still holds rows is never hidden', () => {
  const doc = makeEnvironment()
  const row = makeElement('div', { 'data-chat-flow-key': 'turn-process:4', 'data-chat-flow-kind': 'turn-process' })
  const header = makeElement('button', { 'data-turn-process': '4' })
  header.textContent = '执行了命令'
  row.appendChild(header)
  const content = makeElement('div', { 'data-chat-flow-key': 'compaction:aa', 'data-chat-node-key': 'compaction:aa' })
  content.textContent = '上下文已压缩 · 已压缩 1057 条历史记录'
  row.appendChild(content)
  row.textContent = '执行了命令上下文已压缩 · 已压缩 1057 条历史记录'
  doc.flow.appendChild(row)

  const hidden = api.hideEmptyForkedTurns(doc.flow, [4])
  assert.equal(hidden, 0, 'it holds a compaction card')
  assert.equal(row.getAttribute('data-dsfa-empty-turn'), null)
})

test('both locales carry every key the client asks for', () => {
  const keys = ['action.fork', 'toast.failed', 'toast.unavailable', 'toast.migration', 'compact.fork']
  for (const locale of ['zh', 'en']) {
    for (const key of keys) assert.equal(typeof api.dictionaries[locale][key], 'string', locale + ' ' + key)
  }
})

// --- plugin wiring --------------------------------------------------------------

test('apply registers the overlay seat and the fork round-trip opens the child', async () => {
  const cleanups = []
  const seats = []
  const registered = []
  const definitions = []
  const locales = []
  const forked = []
  const opened = []

  const services = {
    get(key) {
      if (key === 'slots') {
        return {
          inject(slotName, callback) {
            registered.push(slotName)
            return callback()
          },
          register(options, component) {
            seats.push({ options, component })
            return () => seats.pop()
          },
        }
      }
      if (key === 'locale') {
        return {
          register(namespace) {
            locales.push(namespace)
            return () => {}
          },
          bind() {
            return (dictKey) => dictKey
          },
        }
      }
      if (key === 'uiConversation') {
        return {
          events: {
            register(definition) {
              definitions.push(definition)
              return () => {}
            },
          },
        }
      }
      if (key === 'sessions') {
        return {
          fork(request) {
            forked.push(request)
            return Promise.resolve('session-child')
          },
        }
      }
      if (key === 'uiWorkspace') {
        return {
          openSession(id) {
            opened.push(id)
          },
        }
      }
      return undefined
    },
  }
  // `inject` delivers declared services as context properties, which is what the
  // vendored reference half uses (`ctx.locale`, `ctx.slots`, `ctx.uiConversation`).
  const ctx = {
    get: (key) => services.get(key),
    get slots() { return services.get('slots') },
    get locale() { return services.get('locale') },
    get uiConversation() { return services.get('uiConversation') },
    get sessions() { return services.get('sessions') },
    get uiWorkspace() { return services.get('uiWorkspace') },
    effect(callback) {
      cleanups.push(callback())
    },
  }

  // The vendored reference half installs its stylesheet at apply time, so the
  // sandbox needs a document before apply runs - exactly like the browser.
  const applyDoc = makeEnvironment()
  const savedDoc = sandbox.document
  sandbox.document = applyDoc
  const fresh = captured.factory((id) => sandbox.require(id))
  try {
    fresh.apply(ctx)
  } finally {
    sandbox.document = savedDoc
  }

  assert.deepEqual(registered, ['conversation.chat.node', 'conversation.input.overlay'])
  assert.equal(definitions.length, 1, 'the compaction row is a transcript node')
  assert.equal(definitions[0].kind, 'dsh-fork-anywhere-compaction')
  assert.equal(definitions[0].target, 'chat')
  assert.ok(locales.includes('dsh-fork-anywhere'), 'the package registers its own namespace: ' + locales.join(','))
  assert.notEqual(applyDoc.head.querySelector('style'), null, 'its stylesheet is installed')

  const overlay = seats.find((seat) => seat.options.name === 'conversation.input.overlay')
  assert.notEqual(overlay, undefined)
  assert.equal(overlay.options.id, 'fork-turn')

  const doc = makeEnvironment()
  const prompt = makePromptRow({ turn: 2 })
  doc.flow.appendChild(prompt.row)
  const saved = sandbox.document
  sandbox.document = doc
  try {
    const injected = overlay.options.inject('session-source')
    const node = { kind: 'user', data: { seq: 12, content: [{ type: 'text', text: '把这条带到新会话' }] } }
    const snapshot = makeSnapshot({ nodes: new Map([['user:12', node]]), ends: new Map([[1, 30]]) })
    const element = overlay.component({
      ...injected,
      // The standard hook: a selector over the session's ChatSnapshot.
      useChat: (selector) => (typeof selector === 'function' ? selector(snapshot) : snapshot),
    })
    assert.equal(element, null, 'the seat draws nothing; it decorates the transcript')
    // The seat schedules its pass on the next frame (rAF, or a timer here).
    await new Promise((resolve) => setTimeout(resolve, 40))
    const host = prompt.row.querySelector('[data-dsfa-host="1"]')
    assert.notEqual(host, null, 'the seat decorates the transcript on mount')
    host.querySelector('button').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(forked.length, 1)
    // Cross-realm objects (the bundle runs in a vm context) compare field by field.
    assert.equal(forked[0].sessionId, 'session-source')
    assert.equal(forked[0].atSeq, 12)
    assert.equal(forked[0].increaseTitle, true)
    assert.deepEqual(opened, ['session-child'])

  } finally {
    for (const cleanup of sandbox.__effects.splice(0)) cleanup()
    sandbox.document = saved
  }
})

function makeTextNode(text) {
  return { nodeType: 3, textContent: text, parentElement: null }
}
