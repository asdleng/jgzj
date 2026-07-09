#!/usr/bin/env python3
import html
import json
import math
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from weasyprint import HTML

SHANGHAI_TZ = timezone(timedelta(hours=8))
COLORS = ["#14b8a6", "#2563eb", "#f59e0b", "#ef4444", "#8b5cf6", "#10b981", "#f97316", "#64748b"]


def text(value, fallback="-"):
    if value is None:
        return fallback
    value = str(value)
    return value if value else fallback


def esc(value):
    return html.escape(text(value), quote=True)


def number(value, fallback="0"):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return fallback
    if num.is_integer():
        return f"{int(num):,}"
    return f"{num:,.1f}"


def pct(value, total):
    try:
        total = float(total)
        value = float(value)
    except (TypeError, ValueError):
        return "0%"
    if total <= 0:
        return "0%"
    return f"{value * 100 / total:.0f}%"


def date_label(key):
    try:
        return datetime.strptime(str(key), "%Y-%m-%d").strftime("%m/%d")
    except ValueError:
        return text(key)


def time_label(value):
    if not value:
        return "-"
    raw = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is not None:
            dt = dt.astimezone(SHANGHAI_TZ)
        return dt.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(value)


def feature_total(rows):
    return sum(float(row.get("value") or 0) for row in (rows or []))


def polar(cx, cy, r, angle):
    rad = math.radians(angle - 90)
    return cx + r * math.cos(rad), cy + r * math.sin(rad)


def donut_chart(rows, title):
    rows = list(rows or [])[:6]
    total = feature_total(rows)
    if total <= 0:
        return f"""
        <section class="chart-card">
          <h3>{esc(title)}</h3>
          <div class="empty-card">暂无画像</div>
        </section>
        """
    cx = cy = 70
    radius = 52
    width = 18
    angle = 0.0
    paths = []
    legend = []
    for idx, row in enumerate(rows):
        value = float(row.get("value") or 0)
        if value <= 0:
            continue
        start = angle
        end = angle + value * 360 / total
        large = 1 if end - start > 180 else 0
        color = COLORS[idx % len(COLORS)]
        sx, sy = polar(cx, cy, radius, start)
        ex, ey = polar(cx, cy, radius, end)
        paths.append(
            f'<path d="M {sx:.3f} {sy:.3f} A {radius} {radius} 0 {large} 1 {ex:.3f} {ey:.3f}" '
            f'fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" />'
        )
        legend.append(
            f"""
            <li>
              <i style="background:{color}"></i>
              <span>{esc(row.get("label"))}</span>
              <strong>{number(value)} · {pct(value, total)}</strong>
            </li>
            """
        )
        angle = end
    lead = rows[0]
    return f"""
    <section class="chart-card">
      <h3>{esc(title)}</h3>
      <div class="donut-layout">
        <svg class="donut" viewBox="0 0 140 140" role="img" aria-label="{esc(title)}">
          <circle cx="70" cy="70" r="52" fill="none" stroke="#e2e8f0" stroke-width="18" />
          {''.join(paths)}
          <circle cx="70" cy="70" r="36" fill="#fff" />
          <text x="70" y="65" text-anchor="middle" class="donut-main">{esc(lead.get("label"))}</text>
          <text x="70" y="84" text-anchor="middle" class="donut-sub">{pct(lead.get("value"), total)}</text>
        </svg>
        <ul class="legend">{''.join(legend)}</ul>
      </div>
    </section>
    """


def trend_chart(days):
    days = list(days or [])
    if not days:
        return '<p class="empty">没有数据</p>'
    max_people = max(float(day.get("people_total") or 0) for day in days) or 1
    width, height = 700, 210
    pad_left, pad_right, pad_top, pad_bottom = 44, 18, 18, 38
    plot_w = width - pad_left - pad_right
    plot_h = height - pad_top - pad_bottom
    slot = plot_w / max(1, len(days))
    bar_w = max(8, min(34, slot * 0.58))
    label_step = max(1, math.ceil(len(days) / 10))
    bars = []
    for idx, day in enumerate(days):
        value = float(day.get("people_total") or 0)
        bar_h = max(3, value / max_people * plot_h) if value > 0 else 3
        x = pad_left + idx * slot + (slot - bar_w) / 2
        y = pad_top + plot_h - bar_h
        color = "#14b8a6" if value > 0 else "#cbd5e1"
        bars.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{bar_h:.1f}" rx="5" fill="{color}" />')
        if value == max_people or len(days) <= 8:
            bars.append(f'<text x="{x + bar_w / 2:.1f}" y="{max(12, y - 5):.1f}" text-anchor="middle" class="trend-num">{number(value)}</text>')
        if idx % label_step == 0 or idx == len(days) - 1:
            bars.append(f'<text x="{x + bar_w / 2:.1f}" y="{height - 13}" text-anchor="middle" class="trend-label">{esc(date_label(day.get("key")))}</text>')
    grid = []
    for ratio in (0, 0.5, 1):
        y = pad_top + plot_h * (1 - ratio)
        grid.append(f'<line x1="{pad_left}" y1="{y:.1f}" x2="{width - pad_right}" y2="{y:.1f}" />')
        grid.append(f'<text x="{pad_left - 8}" y="{y + 4:.1f}" text-anchor="end" class="trend-label">{number(max_people * ratio)}</text>')
    return f"""
    <svg class="trend-svg" viewBox="0 0 {width} {height}" role="img" aria-label="人流趋势">
      <rect x="0" y="0" width="{width}" height="{height}" rx="14" fill="#f8fafc" stroke="#dbe5ef" />
      <g class="trend-grid">{''.join(grid)}</g>
      <g>{''.join(bars)}</g>
    </svg>
    """


def metric_table(totals, active_days):
    rows = [
        ("识别人数", number(totals.get("people_total"))),
        ("巡逻记录", number(totals.get("sample_count"))),
        ("活跃天数", number(active_days)),
        ("单点峰值", number(totals.get("max_people"))),
    ]
    cells = "".join(
        f'<td><div class="metric-cell"><span>{esc(label)}</span><strong>{esc(value)}</strong></div></td>'
        for label, value in rows
    )
    return f'<table class="metric-table"><tr>{cells}</tr></table>'


def cover_svg(payload, totals, active_days, date_range, generated):
    rows = [
        ("识别人数", number(totals.get("people_total"))),
        ("巡逻记录", number(totals.get("sample_count"))),
        ("活跃天数", number(active_days)),
        ("单点峰值", number(totals.get("max_people"))),
    ]
    metric_nodes = []
    for idx, (label, value) in enumerate(rows):
        x = 30 + idx * 162
        metric_nodes.append(
            f"""
            <rect x="{x}" y="104" width="142" height="42" rx="10" fill="#ffffff" fill-opacity=".16" stroke="#ffffff" stroke-opacity=".22" />
            <text x="{x + 14}" y="121" fill="#ffffff" fill-opacity=".76" font-size="10">{esc(label)}</text>
            <text x="{x + 14}" y="141" fill="#ffffff" font-size="20" font-weight="900">{esc(value)}</text>
            """
        )
    vehicle_id = payload.get("vehicle_id", "-")
    return f"""
    <svg class="cover-svg" viewBox="0 0 700 160" role="img" aria-label="园区人流报告封面">
      <rect x="0" y="0" width="700" height="160" rx="16" fill="#0f766e" />
      <path d="M 350 0 H 700 V 160 H 260 C 345 124 388 88 430 0 Z" fill="#0ea5e9" opacity=".65" />
      <path d="M 520 0 H 700 V 160 H 620 C 590 112 575 58 600 0 Z" fill="#1e293b" opacity=".30" />
      <circle cx="720" cy="0" r="120" fill="none" stroke="#ffffff" stroke-opacity=".14" stroke-width="34" />
      <text x="30" y="38" fill="#ffffff" fill-opacity=".86" font-size="10" font-weight="800" letter-spacing="1.8">PARK PEOPLE FLOW REPORT</text>
      <text x="30" y="72" fill="#ffffff" font-size="28" font-weight="900">{esc(vehicle_id)} 园区人流报告</text>
      <text x="30" y="96" fill="#ffffff" fill-opacity=".84" font-size="11">日期范围：{esc(date_range)} · 生成时间：{esc(generated)}</text>
      {''.join(metric_nodes)}
    </svg>
    """


def chart_table(features):
    cards = [
        donut_chart(features.get("age_stage_groups") or [], "客群阶段"),
        donut_chart(features.get("gender_groups") or [], "性别结构"),
        donut_chart(features.get("person_attributes") or [], "人员属性"),
        donut_chart(features.get("attention_signals") or [], "关照线索"),
    ]
    return f"""
    <table class="chart-table">
      <tr><td>{cards[0]}</td><td>{cards[1]}</td></tr>
      <tr><td>{cards[2]}</td><td>{cards[3]}</td></tr>
    </table>
    """


def insight_panel(items):
    return f"""
    <section class="panel">
      <h2>关键结论</h2>
      <ul>{insight_list(items)}</ul>
    </section>
    """


def date_overview_panel(days):
    return f"""
    <section class="panel">
      <h2>日期概览</h2>
      {daily_cards(days)}
    </section>
    """


def daily_cards(days):
    days = list(days or [])
    if not days:
        return '<p class="empty">没有数据</p>'
    rows = []
    for start in range(0, len(days), 7):
        cells = []
        for day in days[start:start + 7]:
            active = float(day.get("people_total") or 0) > 0
            cells.append(
                f"""
                <td class="{'is-active' if active else ''}">
                  <span>{esc(date_label(day.get("key")))}</span>
                  <strong>{number(day.get("people_total"))}</strong>
                </td>
                """
            )
        while len(cells) < 7:
            cells.append("<td></td>")
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return f'<table class="day-table">{"".join(rows)}</table>'


def mercator_xy(lng, lat, zoom):
    scale = 256 * (2 ** int(zoom))
    x = (float(lng) + 180.0) / 360.0 * scale
    sin_lat = math.sin(math.radians(max(-85.05112878, min(85.05112878, float(lat)))))
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * scale
    return x, y


def heatmap_overlay(points, static_map):
    points = list(points or [])
    if not points:
        return '<div class="heatmap-empty">本期暂无有效热力点</div>'
    if not static_map or not static_map.get("image_data_uri"):
        return '<div class="heatmap-empty">地图底图暂不可用，请稍后重新生成报告。</div>'
    width, height = 700, 320
    map_width = float(static_map.get("width") or 1024)
    map_height = float(static_map.get("height") or 468)
    zoom = int(static_map.get("zoom") or 16)
    center = static_map.get("center") or {}
    center_lng = float(center.get("lng"))
    center_lat = float(center.get("lat"))
    center_x, center_y = mercator_xy(center_lng, center_lat, zoom)
    scale_x = width / map_width
    scale_y = height / map_height
    max_count = max(float(p.get("count") or 0) for p in points) or 1
    circles = []
    for p in sorted(points, key=lambda item: float(item.get("count") or 0)):
        lng = float(p["lng"])
        lat = float(p["lat"])
        count = float(p.get("count") or 0)
        px, py = mercator_xy(lng, lat, zoom)
        x = width / 2 + (px - center_x) * scale_x
        y = height / 2 + (py - center_y) * scale_y
        if x < -80 or x > width + 80 or y < -80 or y > height + 80:
            continue
        ratio = max(0.12, min(1.0, count / max_count))
        r = 9 + ratio * 34
        opacity = 0.20 + ratio * 0.42
        circles.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#ef4444" opacity="{opacity:.3f}" />')
        if ratio > 0.65:
            circles.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{max(4, r * 0.25):.1f}" fill="#fbbf24" opacity="0.82" />')
    return f"""
    <svg class="heatmap-frame" viewBox="0 0 {width} {height}" role="img" aria-label="人流热力图">
      <image href="{esc(static_map.get("image_data_uri"))}" x="0" y="0" width="{width}" height="{height}" preserveAspectRatio="xMidYMid slice" />
      <rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff" opacity=".08" />
      <g>{''.join(circles)}</g>
    </svg>
    """


def representative_photos(images):
    if not images:
        return '<p class="empty">本期没有可用代表图片。</p>'
    cards = []
    for image in images[:2]:
        tags = image.get("scene_tags") or []
        tag_html = "".join(f"<span>{esc(tag)}</span>" for tag in tags[:3])
        cards.append(
            f"""
            <article class="photo-card">
              <img src="{esc(image.get("image_data_uri"))}" alt="代表性脱敏巡逻画面" />
              <div>
                <p>{esc(image.get("caption"))}</p>
                <small>{esc(time_label(image.get("collected_at")))} · {esc(image.get("camera_id"))}</small>
                <div class="tags">{tag_html}</div>
              </div>
            </article>
            """
        )
    return f'<div class="photo-grid">{"".join(cards)}</div>'


def insight_list(items):
    return "".join(f"<li>{esc(item)}</li>" for item in (items or []))


def render(payload):
    totals = payload.get("totals") or {}
    features = payload.get("features") or {}
    days = payload.get("day_series") or []
    generated = time_label(payload.get("generated_at"))
    vehicle_id = payload.get("vehicle_id", "-")
    date_range = f"{payload.get('start_date')} 至 {payload.get('end_date')}"
    active_days = sum(1 for day in days if float(day.get("people_total") or 0) > 0)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    @page {{ size: A4; margin: 14mm 13mm; }}
    * {{ box-sizing: border-box; }}
    header, section, article {{ display: block; }}
    body {{
      margin: 0;
      font-family: "Noto Sans CJK SC", "Noto Sans CJK", "Droid Sans Fallback", sans-serif;
      color: #0f172a;
      font-size: 11px;
      line-height: 1.5;
      background: #ffffff;
    }}
    h1, h2, h3, p, ul {{ margin: 0; }}
    .cover-svg {{ display: block; width: 100%; height: 160px; }}
    .cover-kicker {{ fill: rgba(255,255,255,.86); font-size: 10px; font-weight: 800; letter-spacing: 1.8px; }}
    .cover-title {{ fill: #fff; font-size: 28px; font-weight: 900; }}
    .cover-meta {{ fill: rgba(255,255,255,.84); font-size: 11px; }}
    .cover-metric-label {{ fill: rgba(255,255,255,.76); font-size: 10px; }}
    .cover-metric-value {{ fill: #fff; font-size: 20px; font-weight: 900; }}
    .kicker {{ font-size: 10px; font-weight: 800; letter-spacing: 1.8px; opacity: .86; }}
    h1 {{ margin-top: 6px; font-size: 28px; line-height: 1.15; }}
    .meta {{ margin-top: 10px; color: rgba(255,255,255,.84); }}
    .metric-table {{
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin-top: 14px;
      table-layout: fixed;
    }}
    .metric-table td {{
      width: 25%;
      padding: 0 4px;
    }}
    .metric-cell {{
      padding: 10px 12px 12px;
      border-radius: 12px;
      background: rgba(255,255,255,.16);
      border: 1px solid rgba(255,255,255,.18);
    }}
    .metric-table span {{ display: block; font-size: 10px; color: rgba(255,255,255,.76); }}
    .metric-table strong {{ display: block; margin-top: 3px; font-size: 20px; line-height: 1.15; }}
    section {{ margin-top: 14px; page-break-inside: avoid; }}
    h2 {{ font-size: 16px; margin-bottom: 9px; color: #0f172a; }}
    h3 {{ font-size: 12px; margin-bottom: 8px; color: #164e63; }}
    .panel {{
      border: 1px solid #dbe5ef;
      border-radius: 14px;
      padding: 13px;
      background: #fff;
    }}
    .panel ul {{ padding-left: 17px; }}
    .panel li {{ margin-bottom: 6px; }}
    .day-table {{
      width: 100%;
      border-collapse: separate;
      border-spacing: 5px;
    }}
    .day-table td {{
      width: 14.285%;
      border-radius: 9px;
      padding: 6px 5px;
      background: #f1f5f9;
      color: #64748b;
      text-align: center;
    }}
    .day-table td.is-active {{ background: #ecfeff; color: #0f766e; border: 1px solid #99f6e4; }}
    .day-table span {{ display:block; font-size: 9px; }}
    .day-table strong {{ display:block; font-size: 12px; }}
    .trend-svg {{ width: 100%; height: 210px; }}
    .trend-grid line {{ stroke: #cbd5e1; stroke-width: 1; opacity: .58; }}
    .trend-label {{ fill: #64748b; font-size: 8px; }}
    .trend-num {{ fill: #0f766e; font-size: 9px; font-weight: 800; }}
    .chart-table {{
      width: 100%;
      border-collapse: separate;
      border-spacing: 10px;
      margin: -10px;
    }}
    .chart-table td {{
      width: 50%;
      vertical-align: top;
    }}
    .chart-card {{
      border: 1px solid #dbe5ef;
      border-radius: 14px;
      padding: 12px;
      background: #fff;
    }}
    .donut-layout {{ min-height: 142px; }}
    .donut {{ width: 140px; height: 140px; }}
    .donut-main {{ font-size: 12px; font-weight: 800; fill: #0f172a; }}
    .donut-sub {{ font-size: 15px; font-weight: 900; fill: #0f766e; }}
    .legend {{ list-style: none; padding: 0; margin-left: 150px; margin-top: -132px; }}
    .legend li {{
      padding: 3px 0;
      border-bottom: 1px solid #edf2f7;
    }}
    .legend i {{ display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }}
    .legend span {{ display: inline-block; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }}
    .legend strong {{ float: right; font-size: 10px; color: #334155; }}
    .heatmap-frame {{
      display: block;
      width: 100%;
      height: 320px;
      border-radius: 14px;
      border: 1px solid #dbe5ef;
      background: #e2e8f0;
    }}
    .heatmap-empty, .empty-card, .empty {{
      color: #94a3b8;
      padding: 16px;
      background: #f8fafc;
      border-radius: 12px;
    }}
    .photo-grid {{
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 11px;
    }}
    .photo-card {{
      border: 1px solid #dbe5ef;
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }}
    .photo-card img {{
      width: 100%;
      height: 178px;
      display: block;
      object-fit: cover;
      background: #0f172a;
    }}
    .photo-card div {{ padding: 10px; }}
    .photo-card p {{ font-size: 11px; color: #0f172a; }}
    .photo-card small {{ display: block; margin-top: 5px; color: #64748b; }}
    .tags {{ margin-top: 6px; padding: 0 !important; }}
    .tags span {{
      display: inline-block;
      margin: 0 4px 4px 0;
      padding: 2px 6px;
      border-radius: 999px;
      background: #ecfeff;
      color: #0f766e;
      font-size: 9px;
    }}
    .disclaimer {{
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #f8fafc;
      color: #475569;
      border-left: 4px solid #14b8a6;
    }}
  </style>
</head>
<body>
  {cover_svg(payload, totals, active_days, date_range, generated)}

  {insight_panel(payload.get("insights") or [])}
  {date_overview_panel(days)}

  <section>
    <h2>人流趋势</h2>
    {trend_chart(days)}
  </section>

  <section>
    <h2>人流热力图</h2>
    {heatmap_overlay(payload.get("heatmap_points") or [], payload.get("heatmap_static_map") or {})}
  </section>

  <section>
    <h2>客群画像</h2>
    {chart_table(features)}
  </section>

  <section>
    <h2>代表性画面</h2>
    {representative_photos(payload.get("representative_images") or [])}
  </section>

  <p class="disclaimer">{esc(payload.get("disclaimer"))}</p>
</body>
</html>"""


def main():
    if len(sys.argv) != 3:
        print("usage: render_park_crowd_report_pdf.py input.json output.pdf", file=sys.stderr)
        return 2
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    HTML(string=render(payload), base_url=str(input_path.parent)).write_pdf(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
