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
      default: 20
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

    const height = (element.clientHeight || element.parentElement.clientHeight || 500) + 20
    const width = element.clientWidth || element.parentElement.clientWidth || 800

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

    // Determine which dimension indices to use for source/target group and edge weight
    // based on how many dimensions are in the query.
    //   2 dims → [0]=srcGroup, [1]=tgtGroup
    //   3 dims → [0]=srcID, [1]=srcGroup, [2]=tgtID  (no tgt group: use srcGroup lookup)
    //   4 dims → [0]=srcID, [1]=srcGroup, [2]=tgtID, [3]=tgtGroup
    //   5 dims → [0]=srcID, [1]=srcGroup, [2]=tgtID, [3]=tgtGroup, [4]=edgeWeight
    const ndim = dimensions.length
    const srcGroupIdx  = ndim === 2 ? 0 : 1
    const tgtGroupIdx  = ndim >= 4 ? 3 : (ndim === 2 ? 1 : -1)  // -1 = use sourceGroup lookup
    const edgeWeightDim = ndim >= 5 ? dimensions[4] : null

    console.log('[FDG] dim layout: ndim=' + ndim + ' srcGroupIdx=' + srcGroupIdx + ' tgtGroupIdx=' + tgtGroupIdx)

    // First pass: build a sourceID→group lookup so target nodes can be resolved
    // even when there is no explicit target group dimension (3-dim layout).
    const idToGroup: {[key: string]: string} = {}
    if (tgtGroupIdx === -1) {
      data.forEach((row: Row) => {
        const id = row[dimensions[0].name] && row[dimensions[0].name].value
        const grp = row[dimensions[1].name] && row[dimensions[1].name].value
        if (id != null && grp != null) idToGroup[String(id)] = String(grp)
      })
    }

    // Aggregate rows into group-to-group edges, summing the measure value.
    const linkMap: {[key: string]: number} = {}
    const groupSet: {[key: string]: boolean} = {}

    data.forEach((row: Row) => {
      const srcGrpVal = row[dimensions[srcGroupIdx].name] && row[dimensions[srcGroupIdx].name].value
      if (srcGrpVal == null) return
      const srcGrp = String(srcGrpVal)

      let tgtGrp: string
      if (tgtGroupIdx >= 0) {
        const tgtGrpVal = row[dimensions[tgtGroupIdx].name] && row[dimensions[tgtGroupIdx].name].value
        if (tgtGrpVal == null) return
        tgtGrp = String(tgtGrpVal)
      } else {
        // 3-dim: look up target group from the id→group map
        const tgtIdVal = row[dimensions[2].name] && row[dimensions[2].name].value
        if (tgtIdVal == null) return
        tgtGrp = idToGroup[String(tgtIdVal)] || null
        if (!tgtGrp) return
      }

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

    // Force simulation — tuned for small number of large labeled nodes
    const simulation = d3.forceSimulation(nodes)
      .alphaDecay(0.02)
      .force("link", d3.forceLink(links)
        .distance((d: any) => {
          if (maxLinkVal === minLinkVal) return linkDistance
          const t = (d.value - minLinkVal) / (maxLinkVal - minLinkVal)
          return linkDistance * (3 - 1.5 * t)  // strong→1.5x, weak→3x
        })
        .id(d => (d as any).id))
      .force("charge", d3.forceManyBody().strength(-800))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05 * (width / height)))
      // Large collision so labeled nodes never overlap each other
      .force("collision", (d3 as any).forceCollide().radius((d: any) => nodeRadius(d) + 25).iterations(3))

    const svg = this.svg!
      .attr("width", '100%')
      .attr("height", height)

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on("zoom", function() { container.attr("transform", d3.event.transform) })
    svg.call(zoom as any)

    const container = svg.append("g")

    // One arrow marker per group, colored by that group's color.
    // refX=10 puts the arrowhead tip at the path endpoint.
    // Paths are clipped to node borders in the tick handler so the tip
    // lands exactly at the target circle's edge.
    const defs = svg.append("defs")
    nodes.forEach((n: any) => {
      const c = color(n.id) as string
      const safeId = 'fdg-arrow-' + n.id.replace(/[^a-zA-Z0-9]/g, '_')
      const marker = defs.append("marker")
        .attr("id", safeId)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 10)
        .attr("refY", 0)
        .attr("markerWidth", 8)
        .attr("markerHeight", 8)
        .attr("orient", "auto")
      marker.append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", c)
    })

    // Directed edges — colored by source group, arrow at target border
    const link = container.append("g")
      .attr("fill", "none")
      .selectAll("path")
      .data(links)
      .enter().append("path")
      .attr("stroke", (d: any) => color(d.sourceId) as string)
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", (d: any) => {
        if (maxLinkVal === minLinkVal) return 2
        const t = (d.value - minLinkVal) / (maxLinkVal - minLinkVal)
        return 1 + Math.sqrt(t) * 6  // 1–7 px
      })
      .attr("marker-end", (d: any) =>
        `url(#fdg-arrow-${d.sourceId.replace(/[^a-zA-Z0-9]/g, '_')})`
      )

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

    // Label inside the circle — truncated to fit
    node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .style("font-size", config.font_size || "11px")
      .style("fill", config.font_color || "#fff")
      .style("font-weight", config.font_weight || "bold")
      .style("pointer-events", "none")
      .text((d: any) => {
        const r = nodeRadius(d)
        const maxChars = Math.max(3, Math.floor(r / 4))
        return d.id.length > maxChars ? d.id.slice(0, maxChars - 1) + '…' : d.id
      })

    // Tooltip: full name on hover
    node.append("title").text((d: any) =>
      `${d.id}\nTotal connections: ${degree[d.id] || 0}`
    )

    var tickCount = 0
    simulation.on("tick", () => {
      tickCount++

      link.attr("d", (d: any) => {
        const sx = d.source.x, sy = d.source.y
        const tx = d.target.x, ty = d.target.y
        const dx = tx - sx, dy = ty - sy
        const len = Math.sqrt(dx * dx + dy * dy) || 1

        // Clip path to node borders so arrowhead tip lands at the circle edge
        const srcR = nodeRadius(d.source) + 2
        const tgtR = nodeRadius(d.target) + 3
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
      })

      node.attr("transform", (d: any) => `translate(${d.x},${d.y})`)
    })

    simulation.on("end", () => {
      console.log('[FDG] ended after', tickCount, 'ticks')
      const pad = 60
      const xs = nodes.map((d: any) => d.x).filter((v: number) => !isNaN(v))
      const ys = nodes.map((d: any) => d.y).filter((v: number) => !isNaN(v))
      if (!xs.length) return

      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
      const scale = Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.9
      const tx = width / 2 - scale * ((x0 + x1) / 2)
      const ty = height / 2 - scale * ((y0 + y1) / 2)

      svg.transition().duration(750).call(
        (zoom as any).transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      )
    })

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
