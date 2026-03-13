import * as d3 from 'd3'
import { formatType, handleErrors } from './utils'

import {
  Row,
  Looker,
  VisualizationDefinition
} from './types'

declare var looker: Looker

interface ForceDirectedGraphVisualization extends VisualizationDefinition {
  svg?: any,
}

const vis: ForceDirectedGraphVisualization = {
  id: 'force-directed',
  label: 'Force Directed Graph',
  options: {
    color_range: {
      type: 'array',
      label: 'Color Range',
      display: 'colors',
      default: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
    },
    font_size: {
      type: 'string',
      label: 'Font Size',
      default: ['12px']
    },
    font_color: {
      type: 'string',
      label: 'Font Color',
      default: ['#fff']
    },
    font_weight: {
      type: 'string',
      label: 'Font Weight',
      default: ['bold']
    },
    circle_radius: {
      type: 'string',
      label: 'Circle Radius (base)',
      default: 14
    },
    linkDistance: {
      type: 'string',
      label: 'Link Distance',
      default: 120
    }
  },
  create(element, config) {
    element.style.fontFamily = `"Open Sans", "Helvetica", sans-serif`
    this.svg = d3.select(element).append('svg')
    console.log('[FDG] create() called')
  },
  update(data, element, config, queryResponse, details) {
    console.log('[FDG] update() called, rows:', data.length)

    // Supported dimension layouts (all aggregate to group-level nodes):
    //   2 dims: sourceGroup, targetGroup
    //   3 dims: sourceID, sourceGroup, targetID        (target group looked up via sourceGroup)
    //   4 dims: sourceID, sourceGroup, targetID, targetGroup
    //   5 dims: sourceID, sourceGroup, targetID, targetGroup, edgeWeight
    // measure 0 (optional) = edge weight
    const errResult = handleErrors(this, queryResponse, {
      min_pivots: 0, max_pivots: 0,
      min_dimensions: 2, max_dimensions: 5,
      min_measures: 0, max_measures: 1
    })
    console.log('[FDG] handleErrors result:', errResult)
    if (!errResult) return

    if (!config.color_range) {
      config.color_range = this.options.color_range.default
    }

    this.svg.selectAll("*").remove()

    const height = element.clientHeight || (element.parentElement && element.parentElement.clientHeight) || 500
    const width = element.clientWidth || (element.parentElement && element.parentElement.clientWidth) || 800

    const radius = Number(config.circle_radius) || 20
    const linkDistance = Number(config.linkDistance) || 120

    const drag = simulation => {
      function dragstarted(d) {
        if (!d3.event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x; d.fy = d.y
      }
      function dragged(d) {
        d.fx = d3.event.x; d.fy = d3.event.y
      }
      function dragended(d) {
        if (!d3.event.active) simulation.alphaTarget(0)
        d.fx = null; d.fy = null
      }
      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended)
    }

    const dimensions = queryResponse.fields.dimension_like
    const measure = queryResponse.fields.measure_like[0]

    const colorScale = d3.scaleOrdinal()
    const color = colorScale.range(config.color_range || d3.schemeCategory10)

    // Dimension layouts supported:
    //   2 dims → srcGroup=dim0, tgtGroup=dim1,  weight=measure
    //   3 dims → srcGroup=dim0, tgtGroup=dim1,  weight=dim2   ← "source, target, weight"
    //   4 dims → srcGroup=dim1, tgtGroup=dim3,  weight=measure (person-level: srcID,srcGrp,tgtID,tgtGrp)
    //   5 dims → srcGroup=dim1, tgtGroup=dim3,  weight=dim4   (person-level + weight dim)
    const ndim = dimensions.length
    const srcGroupIdx   = ndim <= 3 ? 0 : 1
    const tgtGroupIdx   = ndim <= 3 ? 1 : 3
    const edgeWeightDim = ndim === 3 ? dimensions[2] : (ndim >= 5 ? dimensions[4] : null)

    console.log('[FDG] ndim=' + ndim + ' srcGrp=dim' + srcGroupIdx + ' tgtGrp=dim' + tgtGroupIdx + ' wt=' + (edgeWeightDim ? edgeWeightDim.name : (measure ? 'measure' : 'none')))

    // Aggregate rows into group-to-group edges, summing the weight value.
    const linkMap: {[key: string]: number} = {}
    const groupSet: {[key: string]: boolean} = {}

    data.forEach((row: Row) => {
      const srcGrpVal = row[dimensions[srcGroupIdx].name] && row[dimensions[srcGroupIdx].name].value
      const tgtGrpVal = row[dimensions[tgtGroupIdx].name] && row[dimensions[tgtGroupIdx].name].value
      if (srcGrpVal == null || tgtGrpVal == null) return
      const srcGrp = String(srcGrpVal)
      const tgtGrp = String(tgtGrpVal)
      if (srcGrp === tgtGrp) return  // skip self-loops

      groupSet[srcGrp] = true
      groupSet[tgtGrp] = true

      const key = srcGrp + '\x00' + tgtGrp
      const val = edgeWeightDim
        ? (Number(row[edgeWeightDim.name].value) || 1)
        : measure ? (Number(row[measure.name].value) || 1) : 1
      linkMap[key] = (linkMap[key] || 0) + val
    })

    const nodes: any[] = Object.keys(groupSet).map(g => ({ id: g, group: g }))
    const links = Object.keys(linkMap).map(key => {
      const sep = key.indexOf('\x00')
      const src = key.slice(0, sep)
      const tgt = key.slice(sep + 1)
      return { source: src, target: tgt, value: linkMap[key], sourceId: src, targetId: tgt }
    })

    console.log('[FDG] groups:', nodes.length, 'directed edges:', links.length)

    if (nodes.length === 0) {
      this.addError({ title: 'No data', message: 'No group-to-group connections found. Check that dimensions 1 and 2 are group fields.' })
      return
    }

    // Edge weight range for stroke scaling
    const linkValues = links.map(l => l.value)
    const maxLinkVal = Math.max(...linkValues) || 1
    const minLinkVal = Math.min(...linkValues) || 1
    console.log('[FDG] edge value range:', minLinkVal, '-', maxLinkVal)

    // Node size by total degree (in + out connections)
    const degree: {[key: string]: number} = {}
    links.forEach(l => {
      degree[l.sourceId] = (degree[l.sourceId] || 0) + 1
      degree[l.targetId] = (degree[l.targetId] || 0) + 1
    })
    const maxDegree = Math.max(1, ...Object.keys(degree).map(k => degree[k]))
    const nodeRadius = (d: any) => radius + Math.sqrt((degree[d.id] || 0) / maxDegree) * radius * 1.5

    // Normalized 0→1 weight position for each edge
    const edgeT = (d: any) => maxLinkVal === minLinkVal ? 0.5
      : (d.value - minLinkVal) / (maxLinkVal - minLinkVal)

    // Stroke width: moderate range so thick edges don't dominate
    const edgeStrokeWidth = (d: any) => 1 + edgeT(d) * edgeT(d) * 9  // 1–10 px

    // Opacity by weight: weak edges fade into background, strong ones pop
    const edgeOpacity = (d: any) => 0.1 + edgeT(d) * 0.75  // 10–85%

    // Arrow marker size scales with stroke width (tip = path endpoint, no extra pullback needed)
    const arrowSize = (d: any) => Math.max(8, edgeStrokeWidth(d) * 1.4)  // 8–22 px

    // Edge label: show rounded value + unit label if available
    const edgeLabel = (d: any) => {
      const unit = edgeWeightDim ? edgeWeightDim.label_short || edgeWeightDim.label || 'hrs'
                                 : measure ? (measure.label_short || measure.label || 'value') : 'value'
      return `${d.sourceId} → ${d.targetId}\n${Math.round(d.value * 10) / 10} ${unit}`
    }

    // Pre-place nodes in a viewport-proportional ellipse so the simulation
    // starts with a layout that already matches the screen shape.
    // This dramatically reduces the number of ticks needed to reach a good layout.
    const rx = width * 0.35, ry = height * 0.35
    nodes.forEach((n: any, i: number) => {
      const angle = (i / nodes.length) * 2 * Math.PI
      const rVar = 0.7 + (i % 5) * 0.06  // vary radius slightly to avoid ring artifacts
      n.x = width / 2 + Math.cos(angle) * rx * rVar
      n.y = height / 2 + Math.sin(angle) * ry * rVar
    })

    // Scale spatial parameters to viewport area so the simulation naturally
    // produces a graph sized to the available space.
    // Reference area 580² ≈ 336k px² → simScale = 1 at that size.
    const simScale = Math.sqrt(width * height) / 580

    const simulation = d3.forceSimulation(nodes)
      .alphaDecay(0.028)  // slightly faster convergence for synchronous mode
      .force("link", d3.forceLink(links)
        .distance((d: any) => {
          // Heavy collab → close; light collab → far apart. Scale with viewport.
          return (linkDistance * 0.4 + (1 - edgeT(d)) * linkDistance * 2.6) * simScale
        })
        .strength((d: any) => 0.05 + edgeT(d) * 0.7)
        .id(d => (d as any).id))
      .force("charge", d3.forceManyBody().strength(-3000 * simScale))
      .force("x", d3.forceX(width / 2).strength(0.02))
      .force("y", d3.forceY(height / 2).strength(0.02))
      .force("collision", (d3 as any).forceCollide()
        .radius((d: any) => (nodeRadius(d) + 50) * Math.max(0.8, simScale))
        .iterations(4))

    const svg = this.svg!
      .attr("width", '100%')
      .attr("height", height)

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on("zoom", function() { container.attr("transform", d3.event.transform) })
    svg.call(zoom as any)

    const container = svg.append("g")

    // Arrow markers — one per link, sized to match that link's stroke width.
    // markerUnits="userSpaceOnUse" gives a FIXED pixel size regardless of stroke-width,
    // so we manually scale each marker by the computed stroke width.
    const defs = svg.append("defs")
    links.forEach((lnk: any) => {
      const c = color(lnk.sourceId) as string
      const mSize = arrowSize(lnk)
      const safeId = 'fdg-arrow-' + lnk.sourceId.replace(/[^a-zA-Z0-9]/g, '_')
                   + '-' + lnk.targetId.replace(/[^a-zA-Z0-9]/g, '_')
      const marker = defs.append("marker")
        .attr("id", safeId)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerUnits", "userSpaceOnUse")  // fixed px, not scaled by stroke-width
        .attr("markerWidth", mSize)
        .attr("markerHeight", mSize)
        .attr("orient", "auto")
      marker.append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", c)
    })

    // Directed edges — colored by source group, arrow at target border
    const linkG = container.append("g").attr("fill", "none")

    const link = linkG.selectAll("path.fdg-edge")
      .data(links)
      .enter().append("path")
      .attr("class", "fdg-edge")
      .attr("stroke", (d: any) => color(d.sourceId) as string)
      .attr("stroke-opacity", edgeOpacity)
      .attr("stroke-width", edgeStrokeWidth)
      .attr("marker-end", (d: any) =>
        `url(#fdg-arrow-${d.sourceId.replace(/[^a-zA-Z0-9]/g, '_')}-${d.targetId.replace(/[^a-zA-Z0-9]/g, '_')})`
      )

    // Invisible wider hit-area paths for edge hover — layered on top of the visible edges
    const linkHit = linkG.selectAll("path.fdg-edge-hit")
      .data(links)
      .enter().append("path")
      .attr("class", "fdg-edge-hit")
      .attr("stroke", "transparent")
      .attr("stroke-width", 20)
      .attr("fill", "none")
      .style("cursor", "pointer")

    // Tooltip div (appended to element, not svg, so it floats above)
    const tooltip = d3.select(element).append("div")
      .style("position", "absolute")
      .style("background", "rgba(0,0,0,0.75)")
      .style("color", "#fff")
      .style("padding", "6px 10px")
      .style("border-radius", "4px")
      .style("font-size", "12px")
      .style("pointer-events", "none")
      .style("white-space", "pre")
      .style("opacity", 0)
      .style("transition", "opacity 0.15s")

    linkHit
      .on("mouseover", function(d: any) {
        tooltip
          .style("opacity", 1)
          .text(edgeLabel(d))
      })
      .on("mousemove", function() {
        const [mx, my] = d3.mouse(element as any)
        tooltip
          .style("left", (mx + 14) + "px")
          .style("top",  (my - 28) + "px")
      })
      .on("mouseout", function() {
        tooltip.style("opacity", 0)
      })

    // ── Node click-to-highlight state ──────────────────────────────────────
    let selectedNode: string | null = null

    const applyHighlight = () => {
      if (selectedNode === null) {
        // Reset everything
        node.select("circle")
          .attr("fill", (d: any) => color(d.id) as string)
          .attr("opacity", 1)
        node.selectAll("text")
          .style("fill", "#333")
          .attr("opacity", 1)
        link.attr("stroke-opacity", edgeOpacity)
            .attr("opacity", 1)
        linkHit.attr("opacity", 1)
      } else {
        // Dim non-selected nodes
        node.select("circle")
          .attr("fill", (d: any) =>
            d.id === selectedNode ? color(d.id) as string : "#ccc"
          )
          .attr("opacity", (d: any) => d.id === selectedNode ? 1 : 0.4)
        node.selectAll("text")
          .style("fill", (d: any) => d.id === selectedNode ? "#333" : "#aaa")
          .attr("opacity", (d: any) => d.id === selectedNode ? 1 : 0.4)
        // Show only edges leaving the selected node at full opacity
        link
          .attr("stroke-opacity", (d: any) => d.sourceId === selectedNode ? 0.85 : 0)
          .attr("opacity",        (d: any) => d.sourceId === selectedNode ? 1 : 0)
        linkHit
          .attr("opacity", (d: any) => d.sourceId === selectedNode ? 1 : 0)
      }
    }

    // Group nodes
    const node = container.append("g")
      .selectAll(".node")
      .data(nodes)
      .enter().append("g")
      .attr("class", "node")
      .call(drag(simulation))

    node.append("circle")
      .attr("r", (d: any) => nodeRadius(d))
      .attr("fill", (d: any) => color(d.id) as string)
      .attr("stroke", "#fff")
      .attr("stroke-width", 2.5)
      .style("cursor", "pointer")

    // Label below the circle — white halo stroke makes it readable over any background
    const labelY = (d: any) => nodeRadius(d) + 14
    const labelText = (d: any) => d.id.length > 22 ? d.id.slice(0, 21) + '…' : d.id

    // White halo (rendered first, under the colored text)
    node.append("text")
      .attr("text-anchor", "middle")
      .attr("y", labelY)
      .style("font-size", config.font_size || "11px")
      .style("font-weight", config.font_weight || "bold")
      .style("pointer-events", "none")
      .attr("stroke", "white")
      .attr("stroke-width", "4px")
      .attr("paint-order", "stroke")
      .style("fill", "#333")
      .text(labelText)

    // Colored text on top
    node.append("text")
      .attr("text-anchor", "middle")
      .attr("y", labelY)
      .style("font-size", config.font_size || "11px")
      .style("font-weight", config.font_weight || "bold")
      .style("pointer-events", "none")
      .style("fill", "#333")
      .text(labelText)

    // Tooltip: full name on hover
    node.append("title").text((d: any) =>
      `${d.id}\nTotal connections: ${degree[d.id] || 0}`
    )

    // Click node to highlight; click same node or background to deselect
    node.on("click", function(d: any) {
      d3.event.stopPropagation()
      selectedNode = selectedNode === d.id ? null : d.id
      applyHighlight()
    })

    // Hover over dimmed nodes: temporarily restore their color
    node
      .on("mouseover.highlight", function(d: any) {
        if (selectedNode === null || d.id === selectedNode) return
        d3.select(this).select("circle")
          .attr("fill", color(d.id) as string)
          .attr("opacity", 0.85)
        d3.select(this).selectAll("text")
          .style("fill", "#333")
          .attr("opacity", 0.85)
      })
      .on("mouseout.highlight", function(d: any) {
        if (selectedNode === null || d.id === selectedNode) return
        d3.select(this).select("circle")
          .attr("fill", "#ccc")
          .attr("opacity", 0.4)
        d3.select(this).selectAll("text")
          .style("fill", "#aaa")
          .attr("opacity", 0.4)
      })

    svg.on("click", function() {
      if (selectedNode !== null) {
        selectedNode = null
        applyHighlight()
      }
    })

    // Shared path geometry computed each tick
    const edgePath = (d: any) => {
      const sx = d.source.x, sy = d.source.y
      const tx = d.target.x, ty = d.target.y
      const dx = tx - sx, dy = ty - sy
      const len = Math.sqrt(dx * dx + dy * dy) || 1

      // Clip path to node borders so arrowhead tip lands at the circle edge.
      // refX=10 puts the arrow TIP exactly at the path endpoint, so no extra offset needed.
      const srcR = nodeRadius(d.source) + 2
      const tgtR = nodeRadius(d.target) + 2
      const startX = sx + (dx / len) * srcR
      const startY = sy + (dy / len) * srcR
      const endX = tx - (dx / len) * tgtR
      const endY = ty - (dy / len) * tgtR

      // Quadratic bezier with perpendicular arc offset.
      // For A→B the offset is in one direction; for B→A the reversed dx/dy
      // naturally produces an offset in the opposite direction — so
      // bidirectional pairs form two distinct visible arcs.
      const arc = Math.min(len * 0.35, 80)
      const cx = (sx + tx) / 2 - (dy / len) * arc
      const cy = (sy + ty) / 2 + (dx / len) * arc

      return `M${startX},${startY}Q${cx},${cy} ${endX},${endY}`
    }

    // Tick handler: only needed for drag interactions — the initial layout
    // is computed synchronously below so there's no visible animated layout phase.
    simulation.on("tick", () => {
      link.attr("d", edgePath)
      linkHit.attr("d", edgePath)
      node.attr("transform", (d: any) => `translate(${d.x},${d.y})`)
    })

    // Run the simulation synchronously: compute the full layout in one JS call,
    // invisible to the user, so there's no "compressed → snap" two-step effect.
    simulation.stop()
    const nTicks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - 0.028))
    for (let i = 0; i < Math.min(nTicks, 400); i++) simulation.tick()
    console.log('[FDG] synchronous ticks:', Math.min(nTicks, 400))

    // Stretch node positions to match the viewport aspect ratio so the graph
    // fills the available space on any screen shape.
    const getCoords = (axis: 'x' | 'y') =>
      nodes.map((d: any) => d[axis]).filter((v: number) => !isNaN(v))

    const xs0 = getCoords('x'), ys0 = getCoords('y')
    if (xs0.length) {
      const gx0 = Math.min(...xs0), gx1 = Math.max(...xs0)
      const gy0 = Math.min(...ys0), gy1 = Math.max(...ys0)
      const graphW = gx1 - gx0 || 1
      const graphH = gy1 - gy0 || 1
      const viewAR  = width / Math.max(height, 1)
      const graphAR = graphW / graphH

      if (viewAR > graphAR * 1.15) {
        const stretch = Math.min(viewAR / graphAR * 0.9, 4)
        const midX = (gx0 + gx1) / 2
        nodes.forEach((n: any) => { n.x = midX + (n.x - midX) * stretch })
      } else if (graphAR > viewAR * 1.15) {
        const stretch = Math.min(graphAR / viewAR * 0.9, 4)
        const midY = (gy0 + gy1) / 2
        nodes.forEach((n: any) => { n.y = midY + (n.y - midY) * stretch })
      }
    }

    // Draw the final positions — no animation, just place everything correctly
    link.attr("d", edgePath)
    linkHit.attr("d", edgePath)
    node.attr("transform", (d: any) => `translate(${d.x},${d.y})`)

    // Zoom-to-fit with a smooth reveal animation
    const pad = 70
    const xs = getCoords('x'), ys = getCoords('y')
    if (xs.length) {
      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
      const fitScale = Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.95
      const ftx = width / 2 - fitScale * ((x0 + x1) / 2)
      const fty = height / 2 - fitScale * ((y0 + y1) / 2)
      svg.transition().duration(600).call(
        (zoom as any).transform,
        d3.zoomIdentity.translate(ftx, fty).scale(fitScale)
      )
    }

    // Fixed legend (not affected by zoom/pan)
    const groups = Object.keys(groupSet).sort()
    if (groups.length > 0) {
      const legendGroups = groups.slice(0, 30)
      const lPad = 8, lItemH = 18
      const lWidth = 170
      const lHeight = legendGroups.length * lItemH + lPad * 2

      const legend = svg.append("g")
        .attr("transform", `translate(10, 10)`)
        .style("pointer-events", "none")

      legend.append("rect")
        .attr("width", lWidth).attr("height", lHeight).attr("rx", 5)
        .attr("fill", "white").attr("fill-opacity", 0.88)
        .attr("stroke", "#ccc").attr("stroke-width", 1)

      legendGroups.forEach((group, i) => {
        const row = legend.append("g")
          .attr("transform", `translate(${lPad}, ${lPad + i * lItemH})`)
        row.append("rect")
          .attr("width", 10).attr("height", 10).attr("y", 2).attr("rx", 2)
          .attr("fill", color(group) as string)
        row.append("text")
          .attr("x", 16).attr("y", 11)
          .style("font-size", "11px").style("fill", "#333")
          .style("font-family", '"Open Sans", "Helvetica", sans-serif')
          .text(group.length > 20 ? group.slice(0, 19) + '…' : group)
      })

      if (groups.length > 30) {
        legend.append("g")
          .attr("transform", `translate(${lPad}, ${lPad + 30 * lItemH})`)
          .append("text")
          .attr("x", 0).attr("y", 11)
          .style("font-size", "10px").style("fill", "#999")
          .text(`+ ${groups.length - 30} more`)
      }
    }
  }
}

looker.plugins.visualizations.add(vis)
