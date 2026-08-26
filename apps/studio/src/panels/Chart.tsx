import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useEffect, useRef } from "react";
import type { SeriesData } from "@sds/core";

/**
 * A small time-series chart.
 *
 * uPlot rather than a React charting library: it renders to canvas, handles tens
 * of thousands of points without complaint, and adds ~15kB. The alternative would
 * put an SVG element per data point into React's reconciler, which is the same
 * mistake the legacy packet renderer made.
 */
export function Chart({
  series,
  height = 108,
  color = "#f08d2c",
  yLabel,
  threshold,
}: {
  series: SeriesData;
  height?: number;
  color?: string;
  yLabel?: string;
  /** Optional horizontal reference line, e.g. an SLO target. */
  threshold?: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const xs = series.points.map((p) => p.t);
    const ys = series.points.map((p) => p.value);
    const data: uPlot.AlignedData = [xs, ys];

    const opts: uPlot.Options = {
      width: host.clientWidth || 300,
      height,
      padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false } },
      legend: { show: false },
      axes: [
        {
          stroke: "#6f675c",
          grid: { stroke: "#221f1a", width: 1 },
          ticks: { stroke: "#221f1a" },
          font: "10px ui-monospace, monospace",
          values: (_u, splits) => splits.map((s) => `${Math.round(s)}s`),
        },
        {
          stroke: "#6f675c",
          grid: { stroke: "#221f1a", width: 1 },
          ticks: { stroke: "#221f1a" },
          font: "10px ui-monospace, monospace",
          size: 44,
          label: yLabel,
          labelSize: yLabel ? 16 : 0,
          labelFont: "10px ui-monospace, monospace",
        },
      ],
      series: [
        {},
        {
          stroke: color,
          width: 1.5,
          fill: `${color}1f`,
          points: { show: false },
        },
      ],
      hooks:
        threshold != null
          ? {
              draw: [
                (u) => {
                  const y = u.valToPos(threshold, "y", true);
                  const ctx = u.ctx;
                  ctx.save();
                  ctx.strokeStyle = "#ed2923";
                  ctx.setLineDash([3, 3]);
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.moveTo(u.bbox.left, y);
                  ctx.lineTo(u.bbox.left + u.bbox.width, y);
                  ctx.stroke();
                  ctx.restore();
                },
              ],
            }
          : {},
    };

    const plot = new uPlot(opts, data, host);
    plotRef.current = plot;

    const observer = new ResizeObserver(() => {
      plot.setSize({ width: host.clientWidth || 300, height });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [series, height, color, yLabel, threshold]);

  if (series.points.length === 0) {
    return <div className="chart-empty">no data</div>;
  }
  return <div className="chart" ref={hostRef} />;
}
