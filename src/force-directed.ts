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
    link_color: {
      type: 'string',
      label: 'Link Color',
      default: ['black']
    },
    font_size: {
      type: 'string',
      label: 'Font Size',
      default: ['10px']
    },
    font_color: {
      type: 'string',
      label: 'Font Color',
      default: ['black']
    },
    font_weight: {
      type: 'string',
      label: 'Font Weight',
      default: ['normal']
    },
    circle_radius: {
      type: 'string',
      label: 'Circle Radius',
      default: 5
    },
    linkDistance: {
      type: 'string',
      label: 'Link Distance',
      default: 30
    },
    labels : {
      type: 'boolean',
      label: 'Show Labels',
      default: false
    },
    labelTypes: {
      type: 'string',
      label: 'Label Node Types',
      default: []
    }
  },
  create(element, config) {
    element.style.fontFamily = `"Open Sans", "Helvetica", sans-serif`
    this.svg = d3.select(element).append('svg')
    console.log('[FDG] create() called')
  },
  update(data, element, config, queryResponse, details) {
    console.log('[FDG] update() called')
    console.log('[FDG] data rows:', data.length)
    console.log('[FDG] element size:', element.clientWidth, 'x', element.clientHeight)
    console.log('[FDG] dimensions:', queryResponse.fields.dimension_like.map(d => d.name))
    console.log('[FDG] measures:', queryResponse.fields.measure_like.map(m => m.name))
    console.log('[FDG] config.color_range:', config.color_range)

    const errResult = handleErrors(this, queryResponse, {
      min_pivots: 0, max_pivots: 0,
      min_dimensions: 3, max_dimensions: 4,
      min_measures: 0, max_measures: 99
    })
    console.log('[FDG] handleErrors result:', errResult)
    if (!errResult) return

    if (!config.color_range) {
      console.log('[FDG] no color_range in config, applying defaults')
      config.color_range = this.options.color_range.default
    }

    this.svg.selectAll("*").remove();

    const height = (element.clientHeight || element.parentElement.clientHeight || 500) + 20
    const width = element.clientWidth || element.parentElement.clientWidth || 800
    console.log('[FDG] computed size:', width, 'x', height)

    var radius = Number(config.circle_radius) || 5
    var linkDistance = Number(config.linkDistance) || 30

    const drag = simulation => {
       function dragstarted(d) {
          if (!d3.event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
       }
       function dragged(d) {
          d.fx = d3.event.x; d.fy = d3.event.y;
       }
       function dragended(d) {
          if (!d3.event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
       }
       return d3.drag()
         .on("start", dragstarted)
         .on("drag", dragged)
         .on("end", dragended);
    }

    const dimensions = queryResponse.fields.dimension_like
    const measure = queryResponse.fields.measure_like[0]
    // Dimension layout (target group removed — now optional 4th dim is edge weight):
    //   dim 0: source node ID
    //   dim 1: source group  (colors ALL nodes that appear as a source)
    //   dim 2: target node ID
    //   dim 3: edge weight dimension (optional — e.g. collaboration hours)
    // Falls back to first measure, then to 1 if neither is present.
    const edgeWeightDim = dimensions.length >= 4 ? dimensions[3] : null
    console.log('[FDG] edge weight source:', edgeWeightDim ? ('dim:' + edgeWeightDim.name) : measure ? ('measure:' + measure.name) : 'none (default 1)')

    const colorScale = d3.scaleOrdinal()
    var color = colorScale.range(config.color_range || d3.schemeCategory10)

    // First pass: build a group lookup from source ID → source group.
    // Only nodes that appear as a SOURCE get a real group/color.
    // Target-only nodes (never a source) stay as '__unknown__' (rendered gray).
    const groupMap: {[key: string]: string} = {}
    data.forEach((row: Row) => {
      const srcVal = row[dimensions[0].name] && row[dimensions[0].name].value
      const srcGroup = row[dimensions[1].name] && row[dimensions[1].name].value
      if (srcVal != null && srcGroup != null) {
        groupMap[String(srcVal)] = String(srcGroup)
      }
    })

    var nodes_unique = []
    var nodes = []
    var links = []

    data.forEach((row: Row) => {
       const srcVal = row[dimensions[0].name] && row[dimensions[0].name].value
       const tgtVal = row[dimensions[2].name] && row[dimensions[2].name].value
       if (srcVal == null || tgtVal == null) return

       if (nodes_unique.indexOf(srcVal) == -1) {
          nodes_unique.push(srcVal);
          nodes.push({ id: srcVal, group: groupMap[String(srcVal)] || '__unknown__' });
       }
       if (nodes_unique.indexOf(tgtVal) == -1) {
          nodes_unique.push(tgtVal);
          // Target nodes only get a color if they also appear as a source in this dataset
          nodes.push({ id: tgtVal, group: groupMap[String(tgtVal)] || '__unknown__' });
       }
       const edgeWeight = edgeWeightDim
         ? (Number(row[edgeWeightDim.name].value) || 1)
         : measure ? (Number(row[measure.name].value) || 1)
         : 1
       links.push({ source: srcVal, target: tgtVal, value: edgeWeight });
    })

    console.log('[FDG] nodes before filter:', nodes.length)
    console.log('[FDG] links:', links.length)
    if (nodes.length > 0) console.log('[FDG] sample node:', JSON.stringify(nodes[0]))
    if (links.length > 0) console.log('[FDG] sample link:', JSON.stringify(links[0]))

    // Remove isolated nodes
    const connectedIds = new Set(
      links.reduce((acc, l) => { acc.push(l.source, l.target); return acc; }, [])
    )
    nodes = nodes.filter(n => connectedIds.has(n.id))
    console.log('[FDG] nodes after filter:', nodes.length)

    if (nodes.length === 0) {
      console.log('[FDG] ERROR: no connected nodes — check dimension field mapping')
      this.addError({ title: 'No data', message: 'No connected nodes found. Check for null values in dimensions.' })
      return
    }

    console.log('[FDG] starting simulation...')

    // Compute edge weight scale: normalize measure values to a 0.5–8px stroke range
    const linkValues = links.map(l => Math.abs(l.value) || 1)
    const maxLinkVal = Math.max(...linkValues) || 1
    const minLinkVal = Math.min(...linkValues) || 1
    console.log('[FDG] link value range:', minLinkVal, '–', maxLinkVal)

    // Compute total degree (in + out) per node so hub nodes that originate
    // many edges are sized correctly, not just nodes that receive many edges.
    const degree: {[key: string]: number} = {}
    links.forEach((l: any) => {
      const srcId = l.source as string
      const tgtId = l.target as string
      degree[srcId] = (degree[srcId] || 0) + 1
      degree[tgtId] = (degree[tgtId] || 0) + 1
    })
    const maxDegree = Math.max(1, ...Object.keys(degree).map(k => degree[k]))
    // Scale node radius: min = base radius, max = 3× base radius (sqrt curve)
    const nodeRadius = (d: any) => radius + Math.sqrt((degree[d.id] || 0) / maxDegree) * radius * 2
    console.log('[FDG] max degree:', maxDegree)

    const simulation = d3.forceSimulation(nodes)
      .alphaDecay(0.05)
      .force("link", d3.forceLink(links)
        // High-collaboration pairs: shorter desired distance (pulled close).
        // Low-collaboration pairs: longer desired distance (stay further apart).
        // Minimum is 3x node radius so overlapping edges are never too cramped.
        .distance((d: any) => {
          if (maxLinkVal === minLinkVal) return linkDistance;
          const t = (Math.abs(d.value) - minLinkVal) / (maxLinkVal - minLinkVal); // 0=weak, 1=strong
          return Math.max(linkDistance * (1 + 2 * (1 - t)), radius * 3); // strong→1x, weak→3x
        })
        // No explicit strength — use d3's default: 1/min(sourceDegree, targetDegree).
        // This prevents hub nodes from collapsing into a "black hole":
        // a node with 50 connections gets strength 0.02/link instead of a fixed 0.7.
        .id(d => (d as any).id))
      // Moderate repulsion — enough breathing room without extreme spreading.
      .force("charge", d3.forceManyBody().strength(-50))
      // forceX/forceY instead of forceCenter:
      //   • Applies proportional spring forces, so disconnected clusters are pulled
      //     back toward center the further they drift (forceCenter can't do this).
      //   • Aspect-ratio-adjusted strengths fill the canvas shape:
      //     stronger y-centering compresses height, letting nodes spread wider in x
      //     to match the typically landscape viewport.
      .force("x", d3.forceX(width / 2).strength(0.04))
      .force("y", d3.forceY(height / 2).strength(0.04 * (width / height)))
      // Enforce a hard minimum gap between node surfaces.
      // Uses the per-node radius so large hub nodes get more personal space.
      // iterations(2) gives more accurate resolution for dense clusters.
      .force("collision", (d3 as any).forceCollide().radius((d: any) => nodeRadius(d) + 3).iterations(2));

    const svg = this.svg!
      .attr("width", '100%')
      .attr("height", height)

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.001, 8])
      .on("zoom", function() {
        container.attr("transform", d3.event.transform)
      })
    svg.call(zoom as any)

    const container = svg.append("g")

    const link = container.append("g")
      .attr("fill", "none")
      .attr("stroke", config.link_color || '#bbb')  // light gray by default
      .attr("stroke-opacity", 0.25)
      .selectAll("path")
      .data(links)
      .enter().append("path")
      .attr("stroke-width", d => {
        // Scale edge thickness by measure value (e.g. collaboration hours).
        // If all values are the same (or no measure), every edge gets width 1.5.
        // Otherwise scale from 0.5px (min) to 6px (max) using a sqrt curve.
        if (maxLinkVal === minLinkVal) return 1.5;
        const t = (Math.abs(d.value) - minLinkVal) / (maxLinkVal - minLinkVal); // 0–1
        return 0.5 + Math.sqrt(t) * 5.5; // 0.5–6 px
      });

    var node = container.append("g")
      .attr("class", "nodes")
      .selectAll(".node")
      .data(nodes)
      .enter().append("g")
      .attr("class", "node")
      .call(drag(simulation));

    node.append("circle")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .attr("r", (d: any) => nodeRadius(d))  // size by total degree
      // Target-only nodes (never a source in this dataset) rendered as light gray.
      // All other nodes get their source group color.
      .attr("fill", (d: any) => d.group === '__unknown__' ? '#d0d0d0' : color(d.group))

    var labelTypes = [];
    if (config.labelTypes && config.labelTypes.length) {
      labelTypes = config.labelTypes.split(',')
    }

    if (config.labelTypes && config.labelTypes.length) {
      node.append("text")
        .style("font-size", config.font_size)
        .style("fill", config.font_color)
        .attr("y", (-1 * config.circle_radius - 3) + "px")
        .style("text-anchor", "middle")
        .style("font-weight", config.font_weight)
        .text(function(d) { return labelTypes.indexOf(d.group) > -1 ? d.id : null });
    } else if (config.labels) {
      node.append("text")
        .style("font-size", config.font_size)
        .style("fill", config.font_color)
        .attr("y", (-1 * config.circle_radius - 3) + "px")
        .style("text-anchor", "middle")
        .style("font-weight", config.font_weight)
        .text(function(d) { return d.id; });
    } else {
      node.append("title").text(function(d) { return d.id });
    }

    var tickCount = 0
    simulation.on("tick", () => {
      tickCount++
      if (tickCount === 1) console.log('[FDG] first tick fired')
      if (tickCount === 10) console.log('[FDG] 10 ticks in, simulation running')

      // Draw edges as quadratic bezier arcs so they curve around nodes rather
      // than passing straight through them. Control point is offset perpendicular
      // to the midpoint by 25% of the edge length (capped at 40px).
      link.attr("d", (d: any) => {
        const sx = isNaN(d.source.x) ? 0 : d.source.x
        const sy = isNaN(d.source.y) ? 0 : d.source.y
        const tx = isNaN(d.target.x) ? 0 : d.target.x
        const ty = isNaN(d.target.y) ? 0 : d.target.y
        const dx = tx - sx, dy = ty - sy
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const arc = Math.min(len * 0.25, 40)
        // Perpendicular offset from midpoint
        const cx = (sx + tx) / 2 - (dy / len) * arc
        const cy = (sy + ty) / 2 + (dx / len) * arc
        return `M${sx},${sy}Q${cx},${cy} ${tx},${ty}`
      });

      // No clamping — let nodes go wherever the physics puts them.
      // The auto-fit on simulation end zooms to show everything.
      node.attr("transform", function(d) {
        if (isNaN(d.x)) return "";
        return "translate(" + d.x + "," + d.y + ")";
      });
    });

    simulation.on("end", () => {
      console.log('[FDG] simulation ended after', tickCount, 'ticks')
      const pad = 40
      const xs = nodes.map((d: any) => d.x).filter((v: number) => !isNaN(v))
      const ys = nodes.map((d: any) => d.y).filter((v: number) => !isNaN(v))
      if (!xs.length) { console.log('[FDG] no valid node positions at end'); return }

      const x0 = Math.min(...xs) - pad
      const x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad
      const y1 = Math.max(...ys) + pad

      const scale = Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.9
      const tx = width / 2 - scale * ((x0 + x1) / 2)
      const ty = height / 2 - scale * ((y0 + y1) / 2)
      console.log('[FDG] auto-fit: scale=', scale, 'tx=', tx, 'ty=', ty)

      svg.transition().duration(750).call(
        (zoom as any).transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      )
    })

    // Fixed legend — appended to svg directly so it stays put during zoom/pan
    const groups = Array.from(new Set(nodes.map((n: any) => n.group)))
      .filter((g: any) => g != null && g !== '' && g !== 'null' && g !== 'undefined' && g !== '__unknown__')
      .sort() as string[]

    if (groups.length > 0) {
      const legendGroups = groups.slice(0, 30) // cap at 30 entries
      const lPad = 8, lItemH = 18
      const lWidth = 170
      const lHeight = legendGroups.length * lItemH + lPad * 2

      const legend = svg.append("g")
        .attr("class", "legend")
        .attr("transform", `translate(10, 10)`)
        .style("pointer-events", "none") // don't interfere with zoom/drag

      // Background box
      legend.append("rect")
        .attr("width", lWidth).attr("height", lHeight)
        .attr("rx", 5)
        .attr("fill", "white").attr("fill-opacity", 0.88)
        .attr("stroke", "#ccc").attr("stroke-width", 1)

      legendGroups.forEach((group, i) => {
        const row = legend.append("g")
          .attr("transform", `translate(${lPad}, ${lPad + i * lItemH})`)

        row.append("rect")
          .attr("width", 10).attr("height", 10).attr("y", 2)
          .attr("fill", color(group) as string)
          .attr("rx", 2)

        row.append("text")
          .attr("x", 16).attr("y", 11)
          .style("font-size", "11px")
          .style("fill", "#333")
          .style("font-family", '"Open Sans", "Helvetica", sans-serif')
          .text(group.length > 20 ? group.slice(0, 19) + '…' : group)
      })

      if (groups.length > 30) {
        const row = legend.append("g")
          .attr("transform", `translate(${lPad}, ${lPad + 30 * lItemH})`)
        row.append("text")
          .attr("x", 0).attr("y", 11)
          .style("font-size", "10px").style("fill", "#999")
          .text(`+ ${groups.length - 30} more`)
      }
    }

    console.log('[FDG] update() setup complete, simulation running in background')
  }
}

looker.plugins.visualizations.add(vis)
