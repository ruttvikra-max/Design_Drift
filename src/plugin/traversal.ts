// traversal.ts — single-pass node tree walker.
// Key rule: stop at COMPONENT/COMPONENT_SET and INSTANCE boundaries.
// Component internals are the design system source of truth, not violations.

export type NodeScope = 'working' | 'instance' | 'component'

export interface CollectedNode {
  id: string
  parentId: string | null
  name: string
  type: string
  depth: number
  scope: NodeScope

  // Structural position — lets us match "the same element" across duplicated
  // screens without depending on names (names collide or are auto-generated).
  screenIndex: number   // 1-based index of the screen this belongs to (0 = none)
  screenFamily: string  // normalized screen name, e.g. "NC Compare 11" -> "NC Compare"
  childIndex: number    // index of this node within its parent's children
  x: number             // position relative to parent (for geometric gap measurement)
  y: number
  width: number
  height: number

  // Component analyzer (instances only)
  isInstance: boolean
  mainComponentId: string | null
  overriddenFields: string[]
  hasFillOverride: boolean  // 'fills' appears in overriddenFields

  // Token analyzer (working scope only, or instance fill overrides)
  hasSolidFill: boolean
  isFillBound: boolean
  fillColorHex: string | null
  hasStroke: boolean
  isStrokeBound: boolean
  rawCornerRadius: number | null
  isCornerRadiusBound: boolean
  rawFontSize: number | null
  isFontSizeBound: boolean

  // Naming analyzer (working + component scope)
  isAutoNamed: boolean

  // Spacing analyzer
  rootFrameId: string | null    // which top-level screen frame this belongs to
  rootFrameName: string         // name of that screen (for violation messages)
  hasAutoLayout: boolean
  paddingTop: number | null
  paddingRight: number | null
  paddingBottom: number | null
  paddingLeft: number | null
  itemSpacing: number | null
  isPaddingBound: boolean
  isItemSpacingBound: boolean
}

export interface TokenLibrary {
  colorHexes: Set<string>
  hasAnyTokens: boolean
}

const NODE_LIMIT = 50000

const AUTO_NAME_RE = /^(Frame|Group|Rectangle|Ellipse|Vector|Text|Component|Instance|Star|Polygon|Line|Arrow|Image|Section|Slice)\s+\d+$/i

export function collectTokenLibrary(): TokenLibrary {
  var hexes = new Set<string>()
  var hasAny = false

  try {
    var allVars = figma.variables.getLocalVariables()
    var allCollections = figma.variables.getLocalVariableCollections()

    for (var vi = 0; vi < allVars.length; vi++) {
      var v = allVars[vi]
      if (v.resolvedType !== 'COLOR') continue
      hasAny = true
      for (var ci = 0; ci < allCollections.length; ci++) {
        var modeId = allCollections[ci].defaultModeId
        var val = v.valuesByMode[modeId]
        if (val && typeof val === 'object' && 'r' in val) {
          hexes.add(rgbToHex(val as RGBA))
        }
      }
    }
  } catch (e) {}

  try {
    if (figma.getLocalPaintStyles().length > 0) hasAny = true
  } catch (e) {}

  return { colorHexes: hexes, hasAnyTokens: hasAny }
}

// A "screen" is any frame/component that is a direct child of the page OR of a
// Section (recursively). Sections are organizational containers, not screens —
// the real screens live inside them. This is why nested screens were previously
// invisible to the analyzer.
function normalizeFamily(name: string): string {
  // Strip a trailing number (and any separators before it): "NC Compare 11" -> "NC Compare"
  var f = name.replace(/[\s\-_]*\d+\s*$/, '')
  f = f.replace(/^\s+/, '').replace(/\s+$/, '')
  return f.length > 0 ? f : name
}

export function traversePage(
  onProgress: (count: number) => void
): { nodes: CollectedNode[]; truncated: boolean } {
  var nodes: CollectedNode[] = []
  var truncated = false
  var screenCounter = 0

  // Walk within a single screen. screenIndex/screenName/screenFamily are fixed
  // for the whole subtree; childIndex/depth are per-node structural position.
  function walk(node: SceneNode, depth: number, parentId: string | null, screenRootId: string, screenName: string, screenFamily: string, screenIndex: number, childIndex: number): void {
    if (nodes.length >= NODE_LIMIT) { truncated = true; return }
    if (!node.visible) return

    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      nodes.push(extractComponent(node, depth, parentId, screenRootId, screenName, screenFamily, screenIndex, childIndex))
      reportProgress(nodes.length, onProgress)
      return
    }
    if (node.type === 'INSTANCE') {
      nodes.push(extractInstance(node as InstanceNode, depth, parentId, screenRootId, screenName, screenFamily, screenIndex, childIndex))
      reportProgress(nodes.length, onProgress)
      return
    }

    nodes.push(extractWorking(node, depth, parentId, screenRootId, screenName, screenFamily, screenIndex, childIndex))
    reportProgress(nodes.length, onProgress)

    if ('children' in node) {
      var parent = node as (SceneNode & ChildrenMixin)
      for (var j = 0; j < parent.children.length; j++) {
        walk(parent.children[j], depth + 1, node.id, screenRootId, screenName, screenFamily, screenIndex, j)
      }
    }
  }

  // Discover screens: descend through the page and any nested Sections, treating
  // every non-Section child as a screen root.
  function discover(container: BaseNode & ChildrenMixin): void {
    var kids = container.children
    for (var i = 0; i < kids.length; i++) {
      if (nodes.length >= NODE_LIMIT) { truncated = true; return }
      var ch = kids[i] as SceneNode
      if (!ch.visible) continue
      if (ch.type === 'SECTION') {
        discover(ch as unknown as (BaseNode & ChildrenMixin))
        continue
      }
      screenCounter++
      walk(ch, 0, null, ch.id, ch.name, normalizeFamily(ch.name), screenCounter, screenCounter - 1)
    }
  }

  discover(figma.currentPage as unknown as (BaseNode & ChildrenMixin))
  return { nodes: nodes, truncated: truncated }
}

function reportProgress(count: number, cb: (n: number) => void): void {
  if (count % 200 === 0) cb(count)
}

// ─── Extractors ──────────────────────────────────────────────────────────────

function readBox(node: SceneNode): { x: number; y: number; width: number; height: number } {
  var n = node as any
  return {
    x: typeof n.x === 'number' ? n.x : 0,
    y: typeof n.y === 'number' ? n.y : 0,
    width: typeof n.width === 'number' ? n.width : 0,
    height: typeof n.height === 'number' ? n.height : 0,
  }
}

function extractComponent(node: SceneNode, depth: number, parentId: string | null, rootFrameId: string | null, rootFrameName: string, screenFamily: string, screenIndex: number, childIndex: number): CollectedNode {
  var box = readBox(node)
  return {
    id: node.id, parentId: parentId, name: node.name, type: node.type, depth: depth,
    scope: 'component',
    screenIndex: screenIndex, screenFamily: screenFamily, childIndex: childIndex, x: box.x, y: box.y, width: box.width, height: box.height,
    isInstance: false, mainComponentId: null, overriddenFields: [], hasFillOverride: false,
    hasSolidFill: false, isFillBound: true, fillColorHex: null,
    hasStroke: false, isStrokeBound: true,
    rawCornerRadius: null, isCornerRadiusBound: true,
    rawFontSize: null, isFontSizeBound: true,
    isAutoNamed: AUTO_NAME_RE.test(node.name),
    rootFrameId: rootFrameId, rootFrameName: rootFrameName,
    hasAutoLayout: false, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null,
    itemSpacing: null, isPaddingBound: true, isItemSpacingBound: true,
  }
}

function extractInstance(node: InstanceNode, depth: number, parentId: string | null, rootFrameId: string | null, rootFrameName: string, screenFamily: string, screenIndex: number, childIndex: number): CollectedNode {
  var mainComponentId: string | null = null
  var overriddenFields: string[] = []
  var hasFillOverride = false

  try {
    mainComponentId = node.mainComponent ? node.mainComponent.id : null
    for (var i = 0; i < node.overrides.length; i++) {
      var o = node.overrides[i]
      for (var j = 0; j < o.overriddenFields.length; j++) {
        var field = o.overriddenFields[j] as string
        if (overriddenFields.indexOf(field) === -1) overriddenFields.push(field)
        if (field === 'fills') hasFillOverride = true
      }
    }
  } catch (e) { mainComponentId = null }

  var hasSolidFill = false
  var isFillBound = true
  var fillColorHex: string | null = null
  if (hasFillOverride) {
    var fillData = readFills(node)
    hasSolidFill = fillData.hasSolidFill
    isFillBound = fillData.isFillBound
    fillColorHex = fillData.fillColorHex
  }

  var spacingData = readSpacing(node)
  var ibox = readBox(node)

  return {
    id: node.id, parentId: parentId, name: node.name, type: node.type, depth: depth,
    scope: 'instance',
    screenIndex: screenIndex, screenFamily: screenFamily, childIndex: childIndex, x: ibox.x, y: ibox.y, width: ibox.width, height: ibox.height,
    isInstance: true, mainComponentId: mainComponentId, overriddenFields: overriddenFields,
    hasFillOverride: hasFillOverride, hasSolidFill: hasSolidFill, isFillBound: isFillBound, fillColorHex: fillColorHex,
    hasStroke: false, isStrokeBound: true,
    rawCornerRadius: null, isCornerRadiusBound: true,
    rawFontSize: null, isFontSizeBound: true,
    isAutoNamed: false,
    rootFrameId: rootFrameId, rootFrameName: rootFrameName,
    hasAutoLayout: spacingData.hasAutoLayout,
    paddingTop: spacingData.paddingTop, paddingRight: spacingData.paddingRight,
    paddingBottom: spacingData.paddingBottom, paddingLeft: spacingData.paddingLeft,
    itemSpacing: spacingData.itemSpacing,
    isPaddingBound: spacingData.isPaddingBound, isItemSpacingBound: spacingData.isItemSpacingBound,
  }
}

function extractWorking(node: SceneNode, depth: number, parentId: string | null, rootFrameId: string | null, rootFrameName: string, screenFamily: string, screenIndex: number, childIndex: number): CollectedNode {
  var fillData = readFills(node)
  var strokeData = readStrokes(node)
  var radiusData = readRadius(node)
  var fontData = readFontSize(node)
  var spacingData = readSpacing(node)
  var wbox = readBox(node)

  return {
    id: node.id, parentId: parentId, name: node.name, type: node.type, depth: depth,
    scope: 'working',
    screenIndex: screenIndex, screenFamily: screenFamily, childIndex: childIndex, x: wbox.x, y: wbox.y, width: wbox.width, height: wbox.height,
    isInstance: false, mainComponentId: null, overriddenFields: [], hasFillOverride: false,
    hasSolidFill: fillData.hasSolidFill, isFillBound: fillData.isFillBound, fillColorHex: fillData.fillColorHex,
    hasStroke: strokeData.hasStroke, isStrokeBound: strokeData.isStrokeBound,
    rawCornerRadius: radiusData.value, isCornerRadiusBound: radiusData.bound,
    rawFontSize: fontData.value, isFontSizeBound: fontData.bound,
    isAutoNamed: AUTO_NAME_RE.test(node.name),
    rootFrameId: rootFrameId, rootFrameName: rootFrameName,
    hasAutoLayout: spacingData.hasAutoLayout,
    paddingTop: spacingData.paddingTop, paddingRight: spacingData.paddingRight,
    paddingBottom: spacingData.paddingBottom, paddingLeft: spacingData.paddingLeft,
    itemSpacing: spacingData.itemSpacing,
    isPaddingBound: spacingData.isPaddingBound, isItemSpacingBound: spacingData.isItemSpacingBound,
  }
}

// ─── Property readers ─────────────────────────────────────────────────────────

function readSpacing(node: SceneNode): {
  hasAutoLayout: boolean
  paddingTop: number | null; paddingRight: number | null
  paddingBottom: number | null; paddingLeft: number | null
  itemSpacing: number | null
  isPaddingBound: boolean; isItemSpacingBound: boolean
} {
  try {
    var n = node as any
    if (!n.layoutMode || n.layoutMode === 'NONE') {
      return { hasAutoLayout: false, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null, itemSpacing: null, isPaddingBound: true, isItemSpacingBound: true }
    }

    var pt = typeof n.paddingTop === 'number' ? n.paddingTop : null
    var pr = typeof n.paddingRight === 'number' ? n.paddingRight : null
    var pb = typeof n.paddingBottom === 'number' ? n.paddingBottom : null
    var pl = typeof n.paddingLeft === 'number' ? n.paddingLeft : null
    var gap = typeof n.itemSpacing === 'number' ? n.itemSpacing : null

    var bv = n.boundVariables
    var isPaddingBound = !!(bv && (bv.paddingTop || bv.paddingRight || bv.paddingBottom || bv.paddingLeft))
    var isItemSpacingBound = !!(bv && bv.itemSpacing)

    return { hasAutoLayout: true, paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl, itemSpacing: gap, isPaddingBound: isPaddingBound, isItemSpacingBound: isItemSpacingBound }
  } catch (e) {
    return { hasAutoLayout: false, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null, itemSpacing: null, isPaddingBound: true, isItemSpacingBound: true }
  }
}

function readFills(node: SceneNode): { hasSolidFill: boolean; isFillBound: boolean; fillColorHex: string | null } {
  var hasSolidFill = false
  var isFillBound = false
  var fillColorHex: string | null = null

  try {
    if (!('fills' in node)) return { hasSolidFill: false, isFillBound: true, fillColorHex: null }
    var fills = (node as GeometryMixin).fills
    if (typeof fills === 'symbol') return { hasSolidFill: false, isFillBound: true, fillColorHex: null }

    for (var i = 0; i < (fills as ReadonlyArray<Paint>).length; i++) {
      var f = (fills as ReadonlyArray<Paint>)[i]
      if (f.type === 'SOLID' && f.visible !== false) {
        hasSolidFill = true
        var rgb = (f as SolidPaint).color
        fillColorHex = rgbToHex({ r: rgb.r, g: rgb.g, b: rgb.b, a: 1 })
        break
      }
    }

    if (hasSolidFill) {
      var bv = (node as any).boundVariables
      if (bv && bv.fills && bv.fills.length > 0) {
        isFillBound = true
      } else {
        var styleId = (node as any).fillStyleId
        if (styleId && typeof styleId === 'string' && styleId.length > 0) {
          isFillBound = true
        }
      }
    } else {
      isFillBound = true
    }
  } catch (e) { isFillBound = true }

  return { hasSolidFill: hasSolidFill, isFillBound: isFillBound, fillColorHex: fillColorHex }
}

function readStrokes(node: SceneNode): { hasStroke: boolean; isStrokeBound: boolean } {
  try {
    if (!('strokes' in node)) return { hasStroke: false, isStrokeBound: true }
    var strokes = (node as GeometryMixin).strokes
    if (typeof strokes === 'symbol') return { hasStroke: false, isStrokeBound: true }

    var hasStroke = false
    for (var i = 0; i < (strokes as ReadonlyArray<Paint>).length; i++) {
      if ((strokes as ReadonlyArray<Paint>)[i].type === 'SOLID') {
        hasStroke = true
        break
      }
    }
    if (!hasStroke) return { hasStroke: false, isStrokeBound: true }

    var bv = (node as any).boundVariables
    if (bv && bv.strokes && bv.strokes.length > 0) return { hasStroke: true, isStrokeBound: true }
    var styleId = (node as any).strokeStyleId
    if (styleId && typeof styleId === 'string' && styleId.length > 0) return { hasStroke: true, isStrokeBound: true }
    return { hasStroke: true, isStrokeBound: false }
  } catch (e) { return { hasStroke: false, isStrokeBound: true } }
}

function readRadius(node: SceneNode): { value: number | null; bound: boolean } {
  try {
    if (!('cornerRadius' in node)) return { value: null, bound: true }
    var cr = (node as any).cornerRadius
    if (typeof cr !== 'number' || cr <= 0) return { value: null, bound: true }
    var bv = (node as any).boundVariables
    if (bv && bv.cornerRadius) return { value: cr, bound: true }
    return { value: cr, bound: false }
  } catch (e) { return { value: null, bound: true } }
}

function readFontSize(node: SceneNode): { value: number | null; bound: boolean } {
  if (node.type !== 'TEXT') return { value: null, bound: true }
  try {
    var textNode = node as TextNode
    var fs = textNode.fontSize
    if (typeof fs !== 'number') return { value: null, bound: true }
    var bv = (textNode as any).boundVariables
    if (bv && bv.fontSize) return { value: fs, bound: true }
    var styleId = (textNode as any).textStyleId
    if (styleId && typeof styleId === 'string' && styleId.length > 0) return { value: fs, bound: true }
    return { value: fs, bound: false }
  } catch (e) { return { value: null, bound: true } }
}

function rgbToHex(color: RGBA): string {
  function toHex(n: number): string {
    var h = Math.round(n * 255).toString(16)
    return h.length === 1 ? '0' + h : h
  }
  return '#' + toHex(color.r) + toHex(color.g) + toHex(color.b)
}
