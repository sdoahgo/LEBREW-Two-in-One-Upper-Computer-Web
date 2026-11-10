"""Pure chart data preparation and canvas coordinate transforms."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Sequence

from .protocol import Telemetry


REALTIME_POINT_LIMIT = 1_200
CALIBRATION_CATEGORIES = ("0.328", "0.529", "0.753", "水(1.000)")


@dataclass(frozen=True)
class PlotSeries:
    name: str
    color: str
    points: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class ChartData:
    series: tuple[PlotSeries, ...]
    x_range: tuple[float, float]
    y_range: tuple[float, float]
    categories: tuple[str, ...] = ()


def realtime_chart_data(
    telemetry: Sequence[Telemetry],
    *,
    limit: int = REALTIME_POINT_LIMIT,
) -> ChartData:
    """Build raw/corrected series from a non-mutated recent telemetry slice."""
    if type(limit) is not int or limit <= 0:
        raise ValueError("limit must be a positive integer")
    recent = tuple(telemetry[-limit:])
    raw_points = tuple(
        (float(sample.sample_sequence), float(sample.humidity_raw))
        for sample in recent
    )
    corrected_points = tuple(
        (float(sample.sample_sequence), float(sample.humidity_corrected))
        for sample in recent
    )
    x_values = tuple(x for x, _ in raw_points)
    y_values = tuple(y for _, y in (*raw_points, *corrected_points))
    return ChartData(
        series=(
            PlotSeries("原始 RH", "#2878b5", raw_points),
            PlotSeries("修正 RH", "#d97706", corrected_points),
        ),
        x_range=_data_range(x_values, pad=False),
        y_range=_data_range(y_values, pad=True),
    )


def calibration_chart_data(
    device_raw: Iterable[float],
    corrected: Iterable[float],
    master: Iterable[float],
) -> ChartData:
    """Build four categorical RH points for raw, chosen correction and master."""
    values = tuple(_four_finite(group) for group in (device_raw, corrected, master))
    x_values = (0.0, 1.0, 2.0, 3.0)
    series = (
        PlotSeries("设备原始", "#2878b5", tuple(zip(x_values, values[0]))),
        PlotSeries("选定修正", "#d97706", tuple(zip(x_values, values[1]))),
        PlotSeries("一号机基准", "#2f855a", tuple(zip(x_values, values[2]))),
    )
    return ChartData(
        series=series,
        x_range=(0.0, 3.0),
        y_range=_data_range(tuple(value for group in values for value in group), pad=True),
        categories=CALIBRATION_CATEGORIES,
    )


def project_points(
    points: Iterable[tuple[float, float]],
    *,
    x_range: tuple[float, float],
    y_range: tuple[float, float],
    width: float,
    height: float,
    padding: float = 28.0,
) -> tuple[tuple[float, float], ...]:
    """Map data points to a padded canvas, with conventional inverted y."""
    if not all(math.isfinite(value) for value in (*x_range, *y_range, width, height, padding)):
        raise ValueError("chart geometry must be finite")
    if width <= padding * 2 or height <= padding * 2 or padding < 0:
        raise ValueError("chart canvas must be larger than twice its padding")
    x_min, x_max = x_range
    y_min, y_max = y_range
    if x_max <= x_min or y_max <= y_min:
        raise ValueError("chart ranges must have positive spans")
    draw_width = width - padding * 2
    draw_height = height - padding * 2
    projected = []
    for x_value, y_value in points:
        if not math.isfinite(x_value) or not math.isfinite(y_value):
            raise ValueError("chart points must be finite")
        x_clamped = min(x_max, max(x_min, x_value))
        y_clamped = min(y_max, max(y_min, y_value))
        x_pixel = padding + (x_clamped - x_min) / (x_max - x_min) * draw_width
        y_pixel = height - padding - (y_clamped - y_min) / (y_max - y_min) * draw_height
        projected.append((x_pixel, y_pixel))
    return tuple(projected)


def draw_chart(canvas, data: ChartData) -> None:
    """Render prepared chart data on a Tk Canvas owned by the UI thread."""
    width = max(float(canvas.winfo_width()), float(canvas.winfo_reqwidth()), 200.0)
    height = max(float(canvas.winfo_height()), float(canvas.winfo_reqheight()), 140.0)
    padding = 38.0
    canvas.delete("all")
    canvas.create_rectangle(
        padding,
        padding,
        width - padding,
        height - padding,
        outline="#9ca3af",
    )
    for fraction in (0.25, 0.5, 0.75):
        y_pixel = padding + (height - 2 * padding) * fraction
        canvas.create_line(
            padding,
            y_pixel,
            width - padding,
            y_pixel,
            fill="#e5e7eb",
        )
    for series in data.series:
        if not series.points:
            continue
        projected = project_points(
            series.points,
            x_range=data.x_range,
            y_range=data.y_range,
            width=width,
            height=height,
            padding=padding,
        )
        flattened = tuple(value for point in projected for value in point)
        if len(projected) > 1:
            canvas.create_line(*flattened, fill=series.color, width=2, smooth=False)
        for x_pixel, y_pixel in projected:
            canvas.create_oval(
                x_pixel - 2,
                y_pixel - 2,
                x_pixel + 2,
                y_pixel + 2,
                fill=series.color,
                outline="",
            )
    if data.categories:
        category_points = project_points(
            tuple((float(index), data.y_range[0]) for index in range(len(data.categories))),
            x_range=data.x_range,
            y_range=data.y_range,
            width=width,
            height=height,
            padding=padding,
        )
        for label, (x_pixel, _) in zip(data.categories, category_points):
            canvas.create_text(x_pixel, height - 15, text=label, fill="#374151")
    legend_x = padding
    legend_y = 16.0
    for series in data.series:
        canvas.create_line(
            legend_x,
            legend_y,
            legend_x + 22,
            legend_y,
            fill=series.color,
            width=3,
            tags="legend",
        )
        canvas.create_oval(
            legend_x + 8,
            legend_y - 3,
            legend_x + 14,
            legend_y + 3,
            fill=series.color,
            outline=series.color,
            tags="legend",
        )
        canvas.create_text(
            legend_x + 29,
            legend_y,
            anchor="w",
            text=series.name,
            fill=series.color,
            font=("Microsoft YaHei UI", 9, "bold"),
            tags="legend",
        )
        legend_x += 42 + max(56, len(series.name) * 14)
    canvas.create_text(
        4,
        padding,
        anchor="nw",
        text=f"{data.y_range[1]:.2f}",
        fill="#6b7280",
    )
    canvas.create_text(
        4,
        height - padding,
        anchor="sw",
        text=f"{data.y_range[0]:.2f}",
        fill="#6b7280",
    )


def _data_range(values: Sequence[float], *, pad: bool) -> tuple[float, float]:
    if not values:
        return (0.0, 1.0)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("chart values must be finite")
    minimum = min(values)
    maximum = max(values)
    if minimum == maximum:
        margin = max(abs(minimum) * 0.05, 1.0)
        return (minimum - margin, maximum + margin)
    margin = (maximum - minimum) * 0.05 if pad else 0.0
    return (minimum - margin, maximum + margin)


def _four_finite(values: Iterable[float]) -> tuple[float, float, float, float]:
    result = tuple(float(value) for value in values)
    if len(result) != 4 or not all(math.isfinite(value) for value in result):
        raise ValueError("calibration chart requires four finite values per series")
    return result
