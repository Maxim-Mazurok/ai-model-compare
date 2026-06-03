import { useEffect, useMemo, useRef, useState } from "react";
import type { ScoredVariant } from "./types";
import { formatNumber, formatPrice } from "./modelMath";

type PlotPoint = ScoredVariant & {
  x: number;
  y: number;
  r: number;
};

type TooltipContext = {
  samePriceProviders: string[];
  regionHint: string | null;
};

export type XAxisMode = "log" | "linear";

type ScatterPlotProps = {
  points: ScoredVariant[];
  frontier: ScoredVariant[];
  selectedId: string | null;
  metricLabel: string;
  costLabel: string;
  costSuffix: string;
  valueUnitForPoint: (point: ScoredVariant) => string;
  speedLabel: string;
  speedHigherIsBetter: boolean;
  formatSpeedForPoint: (point: ScoredVariant) => string;
  xAxisMode: XAxisMode;
  colorForProvider: (provider: string) => string;
  onSelect: (id: string) => void;
};

const defaultWidth = 920;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function logScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  const min = Math.log10(domainMin);
  const max = Math.log10(domainMax);
  return (value: number) => {
    const next = (Math.log10(value) - min) / (max - min || 1);
    return rangeMin + next * (rangeMax - rangeMin);
  };
}

function linearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  return (value: number) => {
    const next = (value - domainMin) / (domainMax - domainMin || 1);
    return rangeMin + next * (rangeMax - rangeMin);
  };
}

function priceTicks(min: number, max: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return [];
  const ticks: number[] = [];
  const minimumPower = Math.floor(Math.log10(min));
  const maximumPower = Math.ceil(Math.log10(max));
  for (let power = minimumPower; power <= maximumPower; power += 1) {
    for (const multiplier of [1, 2, 5]) {
      ticks.push(roundTickValue(multiplier * 10 ** power));
    }
  }
  return ticks.filter((tick) => tick >= min && tick <= max);
}

function calculateLinearXAxisDomain(max: number) {
  const tickStep = calculateNiceTickStep(0, max, 5);
  const domainMinimum = 0;
  const domainMaximum = Math.max(Math.ceil(max / tickStep) * tickStep, tickStep);
  return { domainMinimum, domainMaximum, tickStep };
}

function routeKey(point: ScoredVariant) {
  return [
    point.modelSlug || point.label,
    point.pricing.unit ?? "usd_per_1m_tokens",
    point.pricing.input,
    point.pricing.cachedInput,
    point.pricing.output
  ].join("|");
}

function providerModelKey(point: ScoredVariant) {
  return [point.provider, point.modelSlug || point.label].join("|");
}

function regionList(point: ScoredVariant) {
  const regions = point.metadata?.regions;
  return Array.isArray(regions) ? regions.filter((region): region is string => typeof region === "string") : [];
}

function describeRegion(point: ScoredVariant) {
  const regions = regionList(point);
  if (!regions.length) return null;
  return regions.length === 1 ? regions[0] : `${regions[0]} +${regions.length - 1}`;
}

function trimLine(value: string, maxLength = 42) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function roundTickValue(value: number) {
  return Number(value.toFixed(12));
}

function calculateNiceTickStep(minimumValue: number, maximumValue: number, desiredIntervalCount: number) {
  const span = maximumValue - minimumValue;
  const referenceSpan = span > 0 ? span : Math.max(Math.abs(maximumValue), Math.abs(minimumValue), 1);
  const roughStep = referenceSpan / Math.max(1, desiredIntervalCount);
  const stepMagnitude = 10 ** Math.floor(Math.log10(roughStep));
  const stepError = roughStep / stepMagnitude;

  let stepFactor = 1;
  if (stepError >= Math.sqrt(50)) {
    stepFactor = 10;
  } else if (stepError >= Math.sqrt(10)) {
    stepFactor = 5;
  } else if (stepError >= Math.sqrt(2)) {
    stepFactor = 2;
  }

  return stepFactor * stepMagnitude;
}

function buildLinearTicks(domainMinimum: number, domainMaximum: number, tickStep: number) {
  const tickValues: number[] = [];
  for (let tickValue = domainMinimum; tickValue <= domainMaximum + tickStep / 2; tickValue += tickStep) {
    tickValues.push(roundTickValue(tickValue));
  }
  return tickValues;
}

function calculateYAxisDomain(scoreValues: number[]) {
  const scoreMinimum = Math.min(...scoreValues);
  const scoreMaximum = Math.max(...scoreValues);
  const desiredIntervalCount = 4;
  const smallScaleThreshold = 5;

  if (scoreMaximum <= smallScaleThreshold) {
    const tickStep = calculateNiceTickStep(0, scoreMaximum > 0 ? scoreMaximum : 1, desiredIntervalCount);
    const domainMinimum = 0;
    const domainMaximum = Math.max(
      scoreMaximum > 0 ? Math.ceil(scoreMaximum / tickStep) * tickStep : 0,
      tickStep * desiredIntervalCount
    );

    return { domainMinimum, domainMaximum, tickStep };
  }

  const scoreRange = scoreMaximum - scoreMinimum;
  const tickStep =
    scoreRange > 0
      ? calculateNiceTickStep(scoreMinimum, scoreMaximum, desiredIntervalCount)
      : calculateNiceTickStep(0, scoreMaximum, desiredIntervalCount);

  if (scoreRange === 0) {
    const domainMaximum = Math.ceil((scoreMaximum + tickStep * 2) / tickStep) * tickStep;
    const domainMinimum = Math.max(0, domainMaximum - tickStep * desiredIntervalCount);
    return { domainMinimum, domainMaximum, tickStep };
  }

  const domainMinimum = Math.max(0, Math.floor(scoreMinimum / tickStep) * tickStep);
  const domainMaximum = Math.ceil(scoreMaximum / tickStep) * tickStep;

  return { domainMinimum, domainMaximum, tickStep };
}

function formatYAxisTickDigits(tickStep: number) {
  if (!Number.isFinite(tickStep) || tickStep <= 0) return 0;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(tickStep))));
}

function bubbleSpeedValue(point: ScoredVariant, speedHigherIsBetter: boolean) {
  const value = point.comparisonSpeedValue;
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return speedHigherIsBetter ? value : 1 / value;
}

export function ScatterPlot({
  points,
  frontier,
  selectedId,
  metricLabel,
  costLabel,
  costSuffix,
  valueUnitForPoint,
  speedLabel,
  speedHigherIsBetter,
  formatSpeedForPoint,
  xAxisMode,
  colorForProvider,
  onSelect
}: ScatterPlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<PlotPoint | null>(null);
  const [plotSize, setPlotSize] = useState({ width: defaultWidth, height: 500 });

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const nextWidth = clamp(Math.round(rect.width), 340, defaultWidth);
      setPlotSize({
        width: nextWidth,
        height: nextWidth < 560 ? 430 : 500
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plot = useMemo(() => {
    const width = plotSize.width;
    const height = plotSize.height;
    const margin =
      width < 560
        ? { top: 28, right: 18, bottom: 58, left: 52 }
        : { top: 26, right: 32, bottom: 62, left: 68 };
    const usable = points.filter(
      (point) =>
        point.comparisonCost !== null &&
        point.comparisonCost > 0 &&
        point.metricValue !== null &&
        Number.isFinite(point.comparisonCost) &&
        Number.isFinite(point.metricValue)
    );

    if (!usable.length) {
      return {
        points: [] as PlotPoint[],
        frontierPath: "",
        xTicks: [],
        yTicks: [],
        yTickDigits: 0,
        xDomain: [0.1, 10] as [number, number],
        yDomain: [0, 70] as [number, number],
        margin
      };
    }

    const costs = usable.map((point) => point.comparisonCost!);
    const scores = usable.map((point) => point.metricValue!);
    const speeds = usable.map((point) => bubbleSpeedValue(point, speedHigherIsBetter));
    const logXMin = Math.max(0.01, Math.min(...costs) * 0.75);
    const logXMax = Math.max(...costs) * 1.35;
    const linearXAxisDomain = calculateLinearXAxisDomain(Math.max(...costs) * 1.08);
    const xMin = xAxisMode === "linear" ? linearXAxisDomain.domainMinimum : logXMin;
    const xMax = xAxisMode === "linear" ? linearXAxisDomain.domainMaximum : logXMax;
    const { domainMinimum: yMin, domainMaximum: yMax, tickStep: yTickStep } = calculateYAxisDomain(scores);
    const speedMin = Math.min(...speeds.filter((speed) => speed > 0), 1);
    const speedMax = Math.max(...speeds, speedMin + 1);

    const x =
      xAxisMode === "linear"
        ? linearScale(xMin, xMax, margin.left, width - margin.right)
        : logScale(xMin, xMax, margin.left, width - margin.right);
    const y = linearScale(yMin, yMax, height - margin.bottom, margin.top);
    const r = linearScale(speedMin, speedMax, 7, 18);

    const plotPoints = usable.map((point) => ({
      ...point,
      x: x(point.comparisonCost!),
      y: y(point.metricValue!),
      r: clamp(r(bubbleSpeedValue(point, speedHigherIsBetter) || speedMin), 7, 18)
    }));

    const byId = new Map(plotPoints.map((point) => [point.id, point]));
    const frontierPoints = frontier
      .map((point) => byId.get(point.id))
      .filter(Boolean)
      .sort((a, b) => a!.x - b!.x) as PlotPoint[];
    const frontierPath = frontierPoints
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");

    const yTickDigits = formatYAxisTickDigits(yTickStep);
    const yTicks = buildLinearTicks(yMin, yMax, yTickStep).map((value) => {
      return { value, y: y(value) };
    });

    return {
      points: plotPoints,
      frontierPath,
      xTicks:
        xAxisMode === "linear"
          ? buildLinearTicks(xMin, xMax, linearXAxisDomain.tickStep).map((value) => ({ value, x: x(value) }))
          : priceTicks(xMin, xMax).map((value) => ({ value, x: x(value) })),
      yTicks,
      yTickDigits,
      xDomain: [xMin, xMax] as [number, number],
      yDomain: [yMin, yMax] as [number, number],
      margin
    };
  }, [frontier, plotSize.height, plotSize.width, points, speedHigherIsBetter, xAxisMode]);

  const tooltipContexts = useMemo(() => {
    const byRoute = new Map<string, ScoredVariant[]>();
    const byProviderModel = new Map<string, ScoredVariant[]>();
    for (const point of points) {
      const key = routeKey(point);
      byRoute.set(key, [...(byRoute.get(key) ?? []), point]);
      const providerKey = providerModelKey(point);
      byProviderModel.set(providerKey, [...(byProviderModel.get(providerKey) ?? []), point]);
    }

    const contexts = new Map<string, TooltipContext>();
    for (const point of points) {
      const siblings = byRoute.get(routeKey(point)) ?? [];
      const samePriceProviders = Array.from(new Set(siblings.map((sibling) => sibling.provider))).sort();
      const sameProviderModel = byProviderModel.get(providerModelKey(point)) ?? [];
      contexts.set(point.id, {
        samePriceProviders: samePriceProviders.length > 1 ? samePriceProviders : [],
        regionHint: sameProviderModel.length > 1 ? describeRegion(point) : null
      });
    }
    return contexts;
  }, [points]);

  const active = hovered;
  const activeContext = active ? tooltipContexts.get(active.id) : null;
  const width = plotSize.width;
  const height = plotSize.height;
  const margin = plot.margin;
  const tooltipWidth = 284;
  const tooltipHeight = activeContext?.samePriceProviders.length ? 196 : activeContext?.regionHint ? 174 : 150;
  const tooltipX = active ? clamp(active.x + 14, 16, width - tooltipWidth - 8) : 0;
  const tooltipY = active ? clamp(active.y - 88, 28, height - tooltipHeight - 16) : 0;

  return (
    <div className="plot-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metricLabel} by ${costLabel}`}>
        <rect x="0" y="0" width={width} height={height} rx="0" className="plot-bg" />
        {plot.xTicks.map((tick) => (
          <g key={`x-${tick.value}`}>
            <line x1={tick.x} x2={tick.x} y1={margin.top} y2={height - margin.bottom} className="grid-line" />
            <text x={tick.x} y={height - margin.bottom + 28} textAnchor="middle" className="axis-label">
              {formatNumber(tick.value, tick.value < 1 ? 2 : 1)}
            </text>
          </g>
        ))}
        {plot.yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line x1={margin.left} x2={width - margin.right} y1={tick.y} y2={tick.y} className="grid-line" />
            <text x={margin.left - 16} y={tick.y + 4} textAnchor="end" className="axis-label">
              {formatNumber(tick.value, plot.yTickDigits)}
            </text>
          </g>
        ))}
        <text x={(width + margin.left - margin.right) / 2} y={height - 14} textAnchor="middle" className="axis-title">
          {costLabel}
        </text>
        <text
          transform={`translate(20 ${(height - margin.bottom + margin.top) / 2}) rotate(-90)`}
          textAnchor="middle"
          className="axis-title"
        >
          {metricLabel}
        </text>

        <text x={margin.left + 8} y={margin.top + 18} className="quadrant-label">
          stronger
        </text>
        <text x={width - margin.right - 8} y={height - margin.bottom - 12} textAnchor="end" className="quadrant-label">
          pricier
        </text>

        {plot.frontierPath ? <path d={plot.frontierPath} className="frontier-line" /> : null}

        {plot.points.map((point) => {
          const selected = point.id === selectedId;
          return (
            <g
              className="svg-hit"
              key={point.id}
              role="button"
              tabIndex={0}
              onMouseEnter={() => setHovered(point)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(point)}
              onBlur={() => setHovered(null)}
              onClick={() => onSelect(point.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(point.id);
                }
              }}
              aria-label={`${point.label}, ${point.provider}`}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={selected ? point.r + 3 : point.r}
                fill={colorForProvider(point.provider)}
                className={selected ? "point selected" : "point"}
              />
              <circle cx={point.x} cy={point.y} r={point.r + 9} fill="transparent" />
            </g>
          );
        })}

        {active ? (
          <g className="plot-tooltip" transform={`translate(${tooltipX} ${tooltipY})`}>
            <rect width={tooltipWidth} height={tooltipHeight} rx="6" />
            <text x="12" y="24" className="tooltip-provider">
              {activeContext?.regionHint ? `${active.provider} - ${activeContext.regionHint}` : active.provider}
            </text>
            <text x="12" y="47" className="tooltip-title">
              {trimLine(active.label)}
            </text>
            <text x="12" y="73">
              {metricLabel}: {formatNumber(active.metricValue)}
            </text>
            <text x="12" y="94">
              {costLabel}: {formatPrice(active.comparisonCost, active.pricing.unit)} {costSuffix}
            </text>
            <text x="12" y="115">
              Value: {formatNumber(active.valueScore)} pts per {valueUnitForPoint(active)}
            </text>
            <text x="12" y="136">
              {speedLabel}: {formatSpeedForPoint(active)}
            </text>
            {activeContext?.samePriceProviders.length ? (
              <>
                <text x="12" y="160" className="tooltip-note">
                  Same model + price:
                </text>
                <text x="12" y="180" className="tooltip-note">
                  {trimLine(activeContext.samePriceProviders.join(", "), 48)}
                </text>
              </>
            ) : activeContext?.regionHint ? (
              <text x="12" y="160" className="tooltip-note">
                Region group: {activeContext.regionHint}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  );
}
