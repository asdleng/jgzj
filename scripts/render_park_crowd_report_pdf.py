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
    bars = []
    for day in days:
        value = float(day.get("people_total") or 0)
        height = max(4, min(100, value * 100 / max_people))
        bars.append(
            f"""
            <div class="trend-item">
              <div class="trend-value">{number(value)}</div>
              <div class="trend-bar" style="height:{height:.1f}%"></div>
              <span>{esc(date_label(day.get("key")))}</span>
            </div>
            """
        )
    return f'<div class="trend-bars">{"".join(bars)}</div>'


def daily_cards(days):
    rows = []
    for day in (days or []):
        active = float(day.get("people_total") or 0) > 0
        rows.append(
            f"""
            <div class="day-chip{' is-active' if active else ''}">
              <span>{esc(date_label(day.get("key")))}</span>
              <strong>{number(day.get("people_total"))}</strong>
            </div>
            """
        )
    return f'<div class="day-grid">{"".join(rows)}</div>' if rows else '<p class="empty">没有数据</p>'


def heatmap_svg(points):
    points = list(points or [])
    if not points:
        return '<div class="heatmap-empty">本期暂无有效热力点</div>'
    lngs = [float(p["lng"]) for p in points]
    lats = [float(p["lat"]) for p in points]
    min_lng, max_lng = min(lngs), max(lngs)
    min_lat, max_lat = min(lats), max(lats)
    pad_lng = max((max_lng - min_lng) * 0.08, 0.0002)
    pad_lat = max((max_lat - min_lat) * 0.08, 0.0002)
    min_lng -= pad_lng
    max_lng += pad_lng
    min_lat -= pad_lat
    max_lat += pad_lat
    width, height = 700, 320
    max_count = max(float(p.get("count") or 0) for p in points) or 1
    circles = []
    for p in sorted(points, key=lambda item: float(item.get("count") or 0)):
        lng = float(p["lng"])
        lat = float(p["lat"])
        count = float(p.get("count") or 0)
        x = (lng - min_lng) / max(1e-9, max_lng - min_lng) * width
        y = height - (lat - min_lat) / max(1e-9, max_lat - min_lat) * height
        ratio = max(0.12, min(1.0, count / max_count))
        r = 8 + ratio * 28
        opacity = 0.16 + ratio * 0.34
        circles.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#ef4444" opacity="{opacity:.3f}" />')
        if ratio > 0.65:
            circles.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{max(3, r * 0.25):.1f}" fill="#fbbf24" opacity="0.78" />')
    grid = []
    for i in range(1, 5):
        x = width * i / 5
        y = height * i / 5
        grid.append(f'<line x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{height}" />')
        grid.append(f'<line x1="0" y1="{y:.1f}" x2="{width}" y2="{y:.1f}" />')
    return f"""
    <svg class="heatmap" viewBox="0 0 {width} {height}" role="img" aria-label="人流热力图">
      <defs>
        <linearGradient id="heatBg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#ecfeff"/>
          <stop offset="1" stop-color="#f8fafc"/>
        </linearGradient>
      </defs>
      <rect width="{width}" height="{height}" rx="18" fill="url(#heatBg)" />
      <g class="heat-grid">{''.join(grid)}</g>
      <path d="M 40 {height-58} C 170 {height-120}, 290 {height-84}, 408 {height-162} S 610 {height-210}, 662 62" fill="none" stroke="#94a3b8" stroke-width="10" stroke-linecap="round" opacity=".35"/>
      <path d="M 46 {height-56} C 176 {height-118}, 292 {height-82}, 410 {height-160} S 610 {height-208}, 660 64" fill="none" stroke="#64748b" stroke-width="2.5" stroke-dasharray="8 8" opacity=".55"/>
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
    body {{
      margin: 0;
      font-family: "Noto Sans CJK SC", "Noto Sans CJK", "Droid Sans Fallback", sans-serif;
      color: #0f172a;
      font-size: 11px;
      line-height: 1.5;
      background: #ffffff;
    }}
    h1, h2, h3, p, ul {{ margin: 0; }}
    .cover {{
      position: relative;
      padding: 22px 24px;
      border-radius: 16px;
      background: linear-gradient(135deg, #0f766e, #0ea5e9 58%, #1e293b);
      color: #fff;
      overflow: hidden;
    }}
    .cover:after {{
      content: "";
      position: absolute;
      right: -60px;
      top: -70px;
      width: 210px;
      height: 210px;
      border-radius: 50%;
      border: 32px solid rgba(255,255,255,.14);
    }}
    .kicker {{ font-size: 10px; font-weight: 800; letter-spacing: 1.8px; opacity: .86; }}
    h1 {{ margin-top: 6px; font-size: 28px; line-height: 1.15; }}
    .meta {{ margin-top: 10px; color: rgba(255,255,255,.84); }}
    .metric-grid {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 9px;
      margin: 12px 0 0;
    }}
    .metric {{
      padding: 11px 12px;
      border-radius: 12px;
      background: rgba(255,255,255,.16);
      border: 1px solid rgba(255,255,255,.18);
    }}
    .metric span {{ display: block; font-size: 10px; color: rgba(255,255,255,.76); }}
    .metric strong {{ display: block; margin-top: 3px; font-size: 21px; line-height: 1.2; }}
    section {{ margin-top: 14px; page-break-inside: avoid; }}
    h2 {{ font-size: 16px; margin-bottom: 9px; color: #0f172a; }}
    h3 {{ font-size: 12px; margin-bottom: 8px; color: #164e63; }}
    .panel {{
      border: 1px solid #dbe5ef;
      border-radius: 14px;
      padding: 13px;
      background: #fff;
    }}
    .insights {{
      display: grid;
      grid-template-columns: 1.1fr .9fr;
      gap: 12px;
    }}
    .insights ul {{ padding-left: 17px; }}
    .insights li {{ margin-bottom: 6px; }}
    .day-grid {{
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 5px;
    }}
    .day-chip {{
      border-radius: 9px;
      padding: 6px 5px;
      background: #f1f5f9;
      color: #64748b;
      text-align: center;
    }}
    .day-chip.is-active {{ background: #ecfeff; color: #0f766e; border: 1px solid #99f6e4; }}
    .day-chip span {{ display:block; font-size: 9px; }}
    .day-chip strong {{ display:block; font-size: 12px; }}
    .trend-bars {{
      height: 145px;
      display: flex;
      align-items: flex-end;
      gap: 6px;
      padding: 10px 8px 25px;
      border-radius: 12px;
      background: linear-gradient(#f8fafc, #eef6f7);
      border: 1px solid #dbe5ef;
    }}
    .trend-item {{
      flex: 1;
      min-width: 0;
      height: 100%;
      position: relative;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }}
    .trend-bar {{
      width: 70%;
      min-height: 4px;
      border-radius: 8px 8px 2px 2px;
      background: linear-gradient(180deg, #f59e0b, #14b8a6);
    }}
    .trend-value {{
      position: absolute;
      bottom: calc(100% + 3px);
      display: none;
    }}
    .trend-item span {{
      position: absolute;
      bottom: -20px;
      font-size: 8px;
      color: #64748b;
      white-space: nowrap;
    }}
    .chart-grid {{
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }}
    .chart-card {{
      border: 1px solid #dbe5ef;
      border-radius: 14px;
      padding: 12px;
      background: #fff;
    }}
    .donut-layout {{
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 10px;
      align-items: center;
    }}
    .donut {{ width: 140px; height: 140px; }}
    .donut-main {{ font-size: 12px; font-weight: 800; fill: #0f172a; }}
    .donut-sub {{ font-size: 15px; font-weight: 900; fill: #0f766e; }}
    .legend {{ list-style: none; padding: 0; }}
    .legend li {{
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      gap: 6px;
      align-items: center;
      padding: 3px 0;
      border-bottom: 1px solid #edf2f7;
    }}
    .legend i {{ width: 8px; height: 8px; border-radius: 50%; }}
    .legend span {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    .legend strong {{ font-size: 10px; color: #334155; }}
    .heatmap {{
      width: 100%;
      height: 320px;
      border-radius: 14px;
      border: 1px solid #dbe5ef;
    }}
    .heat-grid line {{ stroke: #cbd5e1; stroke-width: 1; opacity: .36; }}
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
  <header class="cover">
    <p class="kicker">PARK PEOPLE FLOW REPORT</p>
    <h1>{esc(vehicle_id)} 园区人流报告</h1>
    <p class="meta">日期范围：{esc(date_range)} · 生成时间：{esc(generated)}</p>
    <div class="metric-grid">
      <div class="metric"><span>识别人数</span><strong>{number(totals.get("people_total"))}</strong></div>
      <div class="metric"><span>巡逻记录</span><strong>{number(totals.get("sample_count"))}</strong></div>
      <div class="metric"><span>活跃天数</span><strong>{number(active_days)}</strong></div>
      <div class="metric"><span>单点峰值</span><strong>{number(totals.get("max_people"))}</strong></div>
    </div>
  </header>

  <section class="insights">
    <div class="panel">
      <h2>关键结论</h2>
      <ul>{insight_list(payload.get("insights") or [])}</ul>
    </div>
    <div class="panel">
      <h2>日期概览</h2>
      {daily_cards(days)}
    </div>
  </section>

  <section>
    <h2>人流趋势</h2>
    {trend_chart(days)}
  </section>

  <section>
    <h2>人流热力图</h2>
    {heatmap_svg(payload.get("heatmap_points") or [])}
  </section>

  <section>
    <h2>客群画像</h2>
    <div class="chart-grid">
      {donut_chart(features.get("age_stage_groups") or [], "客群阶段")}
      {donut_chart(features.get("gender_groups") or [], "性别结构")}
      {donut_chart(features.get("person_attributes") or [], "人员属性")}
      {donut_chart(features.get("attention_signals") or [], "关照线索")}
    </div>
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
