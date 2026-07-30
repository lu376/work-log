#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
周报生成脚本（SQLite 版）
-----------------------
用法:
  python report.py              # 当前周
  python report.py 30           # 本年第 30 周
  python report.py 2026 30      # 2026 年第 30 周
  python report.py --output r.txt  # 输出到文件
"""

import sys
import json
import sqlite3
import argparse
from pathlib import Path
from datetime import date, datetime, timedelta

DB_PATH = Path(__file__).resolve().parent / "daily" / "worklog.db"


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_current_week():
    today = date.today()
    iso = today.isocalendar()
    return iso[0], iso[1]


def get_week_date_range(year, week):
    jan4 = date(year, 1, 4)
    first_monday = jan4 - timedelta(days=jan4.weekday())
    monday = first_monday + timedelta(weeks=week - 1)
    sunday = monday + timedelta(days=6)
    return monday, sunday


def get_week_records(year, week):
    monday, sunday = get_week_date_range(year, week)
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM records WHERE date BETWEEN ? AND ? ORDER BY date",
        (monday.isoformat(), sunday.isoformat())).fetchall()
    conn.close()
    records = []
    for row in rows:
        records.append({
            "date": row["date"],
            "tasks": json.loads(row["tasks"]),
            "learnings": json.loads(row["learnings"]),
            "outputs": json.loads(row["outputs"]),
            "experiences": json.loads(row["experiences"]),
        })
    return records


def generate_report(year, week):
    monday, sunday = get_week_date_range(year, week)
    records = get_week_records(year, week)

    tasks_total = 0; tasks_done = 0
    completed = []; uncompleted = []
    all_learnings = []; all_outputs = []
    seen_exp = set(); unique_exp = []

    for rec in records:
        d = rec["date"]
        for t in rec["tasks"]:
            tasks_total += 1
            if t["done"]:
                tasks_done += 1
                completed.append((d, t["text"]))
            else:
                uncompleted.append((d, t["text"]))
        for item in rec["learnings"]:
            all_learnings.append((d, item))
        for item in rec["outputs"]:
            all_outputs.append((d, item))
        for item in rec["experiences"]:
            key = item.strip().lower()
            if key not in seen_exp:
                seen_exp.add(key)
                unique_exp.append((d, item))

    rate = round(tasks_done / tasks_total * 100, 1) if tasks_total > 0 else 0

    return {
        "year": year, "week": week,
        "monday": monday, "sunday": sunday,
        "record_count": len(records),
        "tasks_total": tasks_total, "tasks_done": tasks_done,
        "completion_rate": rate,
        "completed": completed, "uncompleted": uncompleted,
        "learnings": all_learnings, "outputs": all_outputs,
        "experiences": unique_exp,
    }


def render_dingtalk(data):
    rate = data["completion_rate"]
    total = data["tasks_total"]; done = data["tasks_done"]; pending = total - done
    header = f"📊 本周工作总结（第{data['week']}周 {data['monday'].strftime('%m/%d')}-{data['sunday'].strftime('%m/%d')}）"

    if total > 0:
        if rate >= 100: overview = f"本周{total}项任务全部完成。"
        elif rate >= 70: overview = f"本周共{total}项任务，完成{done}项（完成率{rate}%），{pending}项待跟进。"
        else: overview = f"本周共{total}项任务，完成{done}项，完成率{rate}%，还有{pending}项需要继续推进。"
    else:
        overview = f"本周共记录{data['record_count']}天。"

    parts = [header + "\n" + overview]
    ct = [t for _, t in data.get("completed", [])]
    if ct:
        preview = "、".join(ct[:5])
        if len(ct) > 5: preview += f"等{done}项"
        parts.append(f"完成内容：{preview}。")

    pt = [t for _, t in data.get("uncompleted", [])]
    if pt: parts.append(f"待跟进：{'、'.join(pt[:3])}。")

    ot = [t for _, t in data.get("outputs", [])]
    if ot: parts.append(f"本周产出：{'、'.join(ot[:6])}。")

    lt = [t for _, t in data.get("learnings", [])]
    if lt:
        short = [l[:40] + "…" if len(l) > 40 else l for l in lt[:6]]
        parts.append(f"收获：{'；'.join(short)}。")

    et = [t for _, t in data.get("experiences", [])]
    if et:
        short = [e[:50] + "…" if len(e) > 50 else e for e in et[:4]]
        parts.append(f"经验沉淀：{'；'.join(short)}。")

    suggestions = []
    if pt:
        suggestions.append(f"优先推进{pt[0]}")
        if len(pt) > 1: suggestions.append(pt[1])
    if not suggestions: suggestions.append("继续学习与积累")
    parts.append(f"下周重点：{'；'.join(suggestions)}。")

    return "\n\n".join(parts)


def parse_args():
    parser = argparse.ArgumentParser(description="周报生成 (SQLite)")
    parser.add_argument("a", nargs="?", type=int, default=None, help="周数或年份")
    parser.add_argument("b", nargs="?", type=int, default=None, help="周数")
    parser.add_argument("-o", "--output", type=str, default=None, metavar="FILE", help="输出到文件")
    return parser.parse_args()


def _resolve_year_week(args):
    cy, cw = get_current_week()
    if args.a is None:
        return cy, cw
    if args.b is None:
        if args.a <= 53: return cy, args.a
        else:
            print(f"[INFO] 显示 {args.a} 年当前周（第{cw}周）")
            return args.a, cw
    else:
        if args.b < 1 or args.b > 53:
            print(f"[ERROR] 周数 {args.b} 无效"); sys.exit(1)
        return args.a, args.b


def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass

    if not DB_PATH.exists():
        print(f"[ERROR] 数据库不存在: {DB_PATH}")
        print(f"        请先运行 app.py 自动创建数据库并迁移数据")
        sys.exit(1)

    args = parse_args()
    year, week = _resolve_year_week(args)
    data = generate_report(year, week)

    if data["record_count"] == 0:
        monday, sunday = get_week_date_range(year, week)
        print(f"[INFO] 第 {week} 周（{monday} ~ {sunday}）暂无记录")
        return

    report = render_dingtalk(data)
    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"[OK] {args.output}")
    else:
        try: print(report)
        except UnicodeEncodeError:
            print(report.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(sys.stdout.encoding or "utf-8", errors="replace"))


if __name__ == "__main__":
    main()
