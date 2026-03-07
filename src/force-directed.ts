import * as d3 from 'd3'
import { formatType, handleErrors } from './utils'

import {
  Row,
  Looker,
  VisualizationDefinition
} from './types'

// Global values provided via the API
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
  },
  update(data, element, config, queryResponse, details) {
    // Allow 1 OR MORE measures — use the first one for link weight
    if (!handleErrors(this, queryResponse, {
      min_pivots: 0, max_pivots: 0,
      min_dimensions: 4, max_dimensions: 4,
      min_measures: 1, max_measures: 99
    })) return

    // Apply defaults if config not yet populated
    if (!config.color_range) {
      config.color_range = this.options.color_range.default
    }

    this.svg.selectAll("*").remove();

    // Use parent element height if clientHeight is 0 (first render timing issue)
    const height = (element.clientHeight || element.parentElement.clientHeight || 500) + 20
    const width = element.clientWidth || element.parentElement.clientWidth || 800

    var radius = 5
    if (config.circle_radius) {
        radius = config.circle_radius;
    }

    var linkDistance = 30
    if (config.linkDistance) {
        linkDistance = config.linkDistance;
    }

    const drag = simulation => {
       function dragstarted(d) {
          if (!d3.event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
       }
       function dragged(d) {
          d.fx = d3.event.x;
          d.fy = d3.event.y;
       }
       function dragended(d) {
          if (!d3.event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
       }
       return d3.drag()
         .on("start", dragstarted)
         .on("drag", dragged)
         .on("end", dragended);
    }

    const dimensions = queryResponse.fields.dimension_like
    // Use the first measure for link weight
    const measure = queryResponse.fields.measure_like[0]

    const colorScale = d3.scaleOrdinal()
    var color = colorScale.range(d3.schemeCategory10)
    if (config.color_range != null) {
        color = colorScale.range(config.color_range)
    }

    var nodes_unique = []
    var nodes = []
    var links = []

    data.forEach((row: Row) => {
       const srcVal = row[dimensions[0].name] && row[dimensions[0].name].value
       const tgtVal = row[dimensions[2].name] && row[dimensions[2].name].value
       if (srcVal == null || tgtVal == null) return

       if (nodes_unique.indexOf(srcVal) == -1) {
          nodes_unique.push(srcVal);
          nodes.push({ id: srcVal, group: row[dimensions[1].name].value });
       }
       if (nodes_unique.indexOf(tgtVal) == -1) {
          nodes_unique.push(tgtVal);
          nodes.push({ id: tgtVal, group: row[dimensions[3].name].value });
       }
       links.push({ source: srcVal, target: tgtVal, value: row[measure.name].value || 1 });
    })

    // Remove isolated nodes
    const connectedIds = new Set(
      links.reduce((acc, l) => { acc.push(l.source, l.target); return acc; }, [])
    )
    nodes = nodes.filter(n => connectedIds.has(n.id))

    if (nodes.length === 0) {
      this.addError({ title: 'No data', message: 'No connected nodes found. Check for null values in dimensions.' })
      return
    }

    const simulation = d3.forceSimulation(nodes)
      .alphaDecay(0.05)
      .force("link", d3.forceLink(links).distance(linkDistance).id(d => (d as any).id))
      .force("charge", d3.forceManyBody())
      .force("center", d3.forceCenter(width / 2, height / 2));

    const svg = this.svg!
      .attr("width", '100%')
      .attr("height", height)

    // Zoom + pan
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.001, 8])
      .on("zoom", function() {
        container.attr("transform", d3.event.transform)
      })
    svg.call(zoom as any)

    const container = svg.append("g")

    const link = container.append("g")
      .attr("stroke", config.link_color || '#999')
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .enter().append("line")
      .attr("stroke-width", d => Math.sqrt(Math.abs(d.value) || 1));

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
      .attr("r", radius)
      .attr("fill", d => color(d.group))

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
        .text(function(d) {
          return labelTypes.indexOf(d.group) > -1 ? d.id : null
        });
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

    simulation.on("tick", () => {
      link
        .attr("x1", d => isNaN(d.source.x) ? 0 : d.source.x)
        .attr("y1", d => isNaN(d.source.y) ? 0 : d.source.y)
        .attr("x2", d => isNaN(d.target.x) ? 0 : d.target.x)
        .attr("y2", d => isNaN(d.target.y) ? 0 : d.target.y);

      node.attr("transform", function(d) {
        if (isNaN(d.x)) return "";
        d.x = Math.max(radius, Math.min(width - radius, d.x));
        d.y = Math.max(radius, Math.min(height - radius, d.y));
        return "translate(" + d.x + "," + d.y + ")";
      });
    });

    // Auto-fit all nodes into view once the simulation settles
    simulation.on("end", () => {
      const pad = 40
      const xs = nodes.map((d: any) => d.x).filter((v: number) => !isNaN(v))
      const ys = nodes.map((d: any) => d.y).filter((v: number) => !isNaN(v))
      if (!xs.length) return

      const x0 = Math.min(...xs) - pad
      const x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad
      const y1 = Math.max(...ys) + pad

      const scale = Math.min(width / (x1 - x0), height / (y1 - y0)) * 0.9
      const tx = width / 2 - scale * ((x0 + x1) / 2)
      const ty = height / 2 - scale * ((y0 + y1) / 2)

      svg.transition().duration(750).call(
        (zoom as any).transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      )
    })
  }
}

looker.plugins.visualizations.add(vis)
