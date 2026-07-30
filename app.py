#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
工作记录 Web 应用服务（SQLite 版）
---------------------------------
启动方式:
  python app.py              # 默认端口 8080
  python app.py --port 9000  # 指定端口

访问方式:
  - 本机: http://localhost:8080
  - 手机: http://<电脑IP>:8080  (同一局域网)

数据存储: daily/worklog.db (SQLite)
首次启动自动从 daily/*.md 迁移已有数据。
"""

import sys
import os
import json
import re
import sqlite3
import argparse
from pathlib import Path
from datetime import date, datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

# ============================================================
# 配置
# ============================================================

ROOT_DIR = Path(__file__).resolve().parent
DAILY_DIR = ROOT_DIR / "daily"
STATIC_DIR = ROOT_DIR / "static"
DB_PATH = DAILY_DIR / "worklog.db"

DAILY_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

# ============================================================
# 数据库
# ============================================================

def get_db() -> sqlite3.Connection:
    """获取数据库连接（自动创建表）。"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("""CREATE TABLE IF NOT EXISTS records (
        date       TEXT PRIMARY KEY,
        tasks      TEXT DEFAULT '[]',
        learnings  TEXT DEFAULT '[]',
        outputs    TEXT DEFAULT '[]',
        experiences TEXT DEFAULT '[]',
        updated_at TEXT
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS refs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT DEFAULT '{}'
    )""")
    conn.commit()
    return conn


def migrate_from_files():
    """首次启动时从 markdown 文件迁移数据到 SQLite。"""
    # 检查是否需要迁移
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
    if count > 0:
        conn.close()
        return

    print("[migrate] Importing existing data into SQLite...")
    imported = 0

    # 迁移每日记录
    for f in sorted(DAILY_DIR.glob("2*.md")):
        data = _parse_md_file(f)
        if not data:
            continue
        date_str = f.stem
        conn.execute("""INSERT OR REPLACE INTO records (date, tasks, learnings, outputs, experiences, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)""",
                     (date_str,
                      json.dumps(data.get("tasks", []), ensure_ascii=False),
                      json.dumps(data.get("learnings", []), ensure_ascii=False),
                      json.dumps(data.get("outputs", []), ensure_ascii=False),
                      json.dumps(data.get("experiences", []), ensure_ascii=False),
                      datetime.now().isoformat()))
        imported += 1

    # 迁移参考资料
    refs_file = DAILY_DIR / "_references.md"
    if refs_file.exists():
        content = refs_file.read_text(encoding="utf-8")
        for i, line in enumerate(_parse_bullet_lines(content)):
            conn.execute("INSERT INTO refs (content, sort_order) VALUES (?, ?)", (line, i))

    # 迁移设置
    settings_file = DAILY_DIR / "_settings.json"
    if settings_file.exists():
        try:
            s = json.loads(settings_file.read_text(encoding="utf-8"))
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                         ("companies", json.dumps(s.get("companies", []), ensure_ascii=False)))
        except Exception:
            pass

    conn.commit()
    conn.close()
    print(f"[migrate] Done. Imported {imported} daily records.")


# ---- 解析兼容层（从 markdown 读取，用于迁移） ----

DATE_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.md$")

def _extract_section(content, emoji, parser_func):
    pattern = rf"^#{{1,4}}\s+{re.escape(emoji)}\s*.+$"
    lines = content.split("\n")
    start = None
    for i, line in enumerate(lines):
        if re.match(pattern, line):
            start = i
            break
    if start is None:
        return None
    section = []
    for i in range(start + 1, len(lines)):
        if re.match(r"^#+\s+", lines[i]):
            break
        section.append(lines[i])
    return parser_func("\n".join(section))

def _parse_tasks(text):
    tasks = []
    for line in text.strip().split("\n"):
        m_done = re.match(r"^-\s*\[x\]\s+(.+)", line, re.IGNORECASE)
        m_todo = re.match(r"^-\s*\[\s*\]\s+(.+)", line)
        if m_done:
            tasks.append({"text": m_done.group(1).strip(), "done": True})
        elif m_todo:
            tasks.append({"text": m_todo.group(1).strip(), "done": False})
    return tasks

def _parse_numbered_list(text):
    items = []
    for line in text.strip().split("\n"):
        m = re.match(r"^\d+[.)]\s+(.+)", line)
        if m:
            items.append(m.group(1).strip())
    return items

def _parse_bullet_lines(text):
    items = []
    for line in text.strip().split("\n"):
        stripped = line.strip()
        if not stripped or stripped in (">", "---", "***"):
            continue
        m = re.match(r"^[-–>]\s*(.+)", stripped)
        if m:
            txt = m.group(1).strip()
            if txt and txt != "_暂无记录_":
                items.append(txt)
    return items

def _parse_md_file(path: Path) -> dict:
    if not path.exists():
        return None
    content = path.read_text(encoding="utf-8")
    result = {}
    for emoji, field, ptype in [("📋","tasks","tasks"), ("💡","learnings","numbered"), ("📦","outputs","bullet"), ("📌","experiences","numbered")]:
        parser = _parse_tasks if ptype == "tasks" else (_parse_numbered_list if ptype == "numbered" else _parse_bullet_lines)
        result[field] = _extract_section(content, emoji, parser) or []
    # 兼容 🤔
    old = _extract_section(content, "🤔", _parse_bullet_lines)
    if old:
        result["learnings"] = result.get("learnings", []) + old
    return result


# ============================================================
# 数据访问
# ============================================================

def db_get_record(date_str: str) -> dict:
    conn = get_db()
    row = conn.execute("SELECT * FROM records WHERE date=?", (date_str,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "tasks": json.loads(row["tasks"]),
        "learnings": json.loads(row["learnings"]),
        "outputs": json.loads(row["outputs"]),
        "experiences": json.loads(row["experiences"]),
    }

def db_save_record(date_str: str, data: dict):
    conn = get_db()
    conn.execute("""INSERT OR REPLACE INTO records (date, tasks, learnings, outputs, experiences, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                 (date_str,
                  json.dumps(data.get("tasks", []), ensure_ascii=False),
                  json.dumps(data.get("learnings", []), ensure_ascii=False),
                  json.dumps(data.get("outputs", []), ensure_ascii=False),
                  json.dumps(data.get("experiences", []), ensure_ascii=False),
                  datetime.now().isoformat()))
    conn.commit()
    conn.close()

def db_delete_record(date_str: str):
    conn = get_db()
    conn.execute("DELETE FROM records WHERE date=?", (date_str,))
    conn.commit()
    conn.close()

def db_get_dates() -> list:
    conn = get_db()
    rows = conn.execute("SELECT date FROM records ORDER BY date DESC").fetchall()
    conn.close()
    return [r["date"] for r in rows]

def db_get_refs() -> list:
    conn = get_db()
    rows = conn.execute("SELECT content FROM refs ORDER BY sort_order").fetchall()
    conn.close()
    return [r["content"] for r in rows]

def db_save_refs(refs: list):
    conn = get_db()
    conn.execute("DELETE FROM refs")
    for i, content in enumerate(refs):
        conn.execute("INSERT INTO refs (content, sort_order) VALUES (?, ?)", (content, i))
    conn.commit()
    conn.close()

def db_get_settings() -> dict:
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key='companies'").fetchone()
    conn.close()
    if not row:
        return {"companies": []}
    try:
        return {"companies": json.loads(row["value"])}
    except Exception:
        return {"companies": []}

def db_save_settings(data: dict):
    conn = get_db()
    companies = json.dumps(data.get("companies", []), ensure_ascii=False)
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('companies', ?)", (companies,))
    conn.commit()
    conn.close()

def db_get_week_records(year: int, week: int) -> list:
    """获取指定周的记录列表。"""
    jan4 = date(year, 1, 4)
    first_monday = jan4 - timedelta(days=jan4.weekday())
    monday = first_monday + timedelta(weeks=week - 1)
    sunday = monday + timedelta(days=6)

    conn = get_db()
    rows = conn.execute("SELECT * FROM records WHERE date BETWEEN ? AND ? ORDER BY date",
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


# ============================================================
# 周报
# ============================================================

def get_current_week():
    today = date.today()
    iso = today.isocalendar()
    return iso[0], iso[1]

def calc_company_weeks(start_date_str: str, target_date: date = None) -> dict:
    if target_date is None:
        target_date = date.today()
    try:
        start = datetime.strptime(start_date_str, "%Y-%m-%d").date()
    except Exception:
        return None
    days = (target_date - start).days
    if days < 0:
        return None
    return {"week_num": days // 7 + 1, "start_date": start_date_str.replace("-", "."), "days": days}

def get_week_report_data(year: int, week: int) -> dict:
    jan4 = date(year, 1, 4)
    first_monday = jan4 - timedelta(days=jan4.weekday())
    monday = first_monday + timedelta(weeks=week - 1)
    sunday = monday + timedelta(days=6)

    records = db_get_week_records(year, week)

    tasks_total = 0; tasks_done = 0
    all_completed = []; all_uncompleted = []; all_learnings = []
    all_outputs = []; seen_exp = set(); unique_exp = []

    for rec in records:
        d = rec["date"]
        for t in rec["tasks"]:
            tasks_total += 1
            if t["done"]:
                tasks_done += 1
                all_completed.append({"date": d, "text": t["text"]})
            else:
                all_uncompleted.append({"date": d, "text": t["text"]})
        for item in rec["learnings"]:
            all_learnings.append({"date": d, "text": item})
        for item in rec["outputs"]:
            all_outputs.append({"date": d, "text": item})
        for item in rec["experiences"]:
            key = item.strip().lower()
            if key not in seen_exp:
                seen_exp.add(key)
                unique_exp.append({"date": d, "text": item})

    rate = round(tasks_done / tasks_total * 100, 1) if tasks_total > 0 else 0

    settings = db_get_settings()
    company_weeks = []
    for c in settings.get("companies", []):
        cw = calc_company_weeks(c["start_date"], sunday)
        if cw:
            company_weeks.append({"name": c["name"], **cw})

    return {
        "year": year, "week": week,
        "monday": monday.strftime("%Y-%m-%d"), "sunday": sunday.strftime("%Y-%m-%d"),
        "record_count": len(records),
        "tasks_total": tasks_total, "tasks_done": tasks_done,
        "completion_rate": rate,
        "completed_tasks": all_completed, "uncompleted_tasks": all_uncompleted,
        "learnings": all_learnings, "outputs": all_outputs,
        "experiences": unique_exp, "company_weeks": company_weeks,
    }

def render_dingtalk_report(data: dict) -> str:
    rate = data["completion_rate"]
    total = data["tasks_total"]; done = data["tasks_done"]; pending = total - done

    header = f"📊 本周工作总结（第{data['week']}周 {data['monday']} ~ {data['sunday']}"
    for cw in data.get("company_weeks", []):
        header += f" | {cw['name']}第{cw['week_num']}周"
    header += "）"

    if total > 0:
        if rate >= 100:
            overview = f"本周{total}项任务全部完成。"
        elif rate >= 70:
            overview = f"本周共{total}项任务，完成{done}项（完成率{rate}%），{pending}项待跟进。"
        else:
            overview = f"本周共{total}项任务，完成{done}项，完成率{rate}%，还有{pending}项需要继续推进。"
    else:
        overview = f"本周共记录{data['record_count']}天。"

    parts = [header + "\n" + overview]

    completed_texts = [t['text'] for t in data.get("completed_tasks", [])]
    if completed_texts:
        preview = "、".join(completed_texts[:5])
        if len(completed_texts) > 5: preview += f"等{done}项"
        parts.append(f"完成内容：{preview}。")

    pending_texts = [t['text'] for t in data.get("uncompleted_tasks", [])]
    if pending_texts:
        parts.append(f"待跟进：{'、'.join(pending_texts[:3])}。")

    outputs = [o['text'] for o in data.get("outputs", [])]
    if outputs:
        parts.append(f"本周产出：{'、'.join(outputs[:6])}。")

    learnings = [l['text'] for l in data.get("learnings", [])]
    if learnings:
        short = [l[:40] + "…" if len(l) > 40 else l for l in learnings[:6]]
        parts.append(f"收获：{'；'.join(short)}。")

    exps = [e['text'] for e in data.get("experiences", [])]
    if exps:
        short = [e[:50] + "…" if len(e) > 50 else e for e in exps[:4]]
        parts.append(f"经验沉淀：{'；'.join(short)}。")

    suggestions = []
    if pending_texts:
        suggestions.append(f"优先推进{pending_texts[0]}")
        if len(pending_texts) > 1: suggestions.append(pending_texts[1])
    if not suggestions: suggestions.append("继续学习与积累")
    parts.append(f"下周重点：{'；'.join(suggestions)}。")

    return "\n\n".join(parts)


# ============================================================
# HTTP 服务
# ============================================================

class RequestHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {args[0]}")

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _send_text(self, text, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(text.encode("utf-8"))

    def _send_file(self, path: Path, content_type: str):
        if not path.exists():
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(path.read_bytes())

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0: return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        params = parse_qs(parsed.query)

        if path == "/api/today":
            data = db_get_record(date.today().isoformat()) or {"tasks":[],"learnings":[],"outputs":[],"experiences":[]}
            self._send_json(data)

        elif path == "/api/dates":
            self._send_json({"dates": db_get_dates()})

        elif path.startswith("/api/record/"):
            date_str = path.split("/")[-1]
            data = db_get_record(date_str)
            if data:
                self._send_json({"date": date_str, **data})
            else:
                self._send_json({"error": "记录不存在"}, 404)

        elif path == "/api/references":
            self._send_json({"references": db_get_refs()})

        elif path == "/api/report":
            year_str = params.get("year", [None])[0]
            week_str = params.get("week", [None])[0]
            fmt = params.get("format", ["json"])[0]
            cy, cw = get_current_week()
            year = int(year_str) if year_str else cy
            week = int(week_str) if week_str else cw
            data = get_week_report_data(year, week)
            if fmt == "text":
                self._send_text(render_dingtalk_report(data))
            else:
                data["dingtalk_text"] = render_dingtalk_report(data)
                self._send_json(data)

        elif path == "/api/settings":
            self._send_json(db_get_settings())

        elif path == "/" or path == "/index.html":
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")

        elif path.startswith("/static/"):
            fp = STATIC_DIR / path.replace("/static/", "", 1)
            ext_map = {".css":"text/css",".js":"application/javascript",".png":"image/png",".svg":"image/svg+xml"}
            self._send_file(fp, ext_map.get(Path(path).suffix, "application/octet-stream"))

        else:
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/save":
            body = self._read_body()
            date_str = body.get("date", date.today().isoformat())
            data = {
                "tasks": body.get("tasks", []),
                "learnings": body.get("learnings", []),
                "outputs": body.get("outputs", []),
                "experiences": body.get("experiences", []),
            }
            try:
                db_save_record(date_str, data)
                self._send_json({"ok": True, "date": date_str})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 500)

        elif path == "/api/references":
            body = self._read_body()
            try:
                db_save_refs(body.get("references", []))
                self._send_json({"ok": True})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 500)

        elif path == "/api/settings":
            body = self._read_body()
            try:
                db_save_settings(body)
                self._send_json({"ok": True})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 500)

        else:
            self._send_json({"error": "Not Found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path.startswith("/api/record/"):
            date_str = path.split("/")[-1]
            try:
                db_delete_record(date_str)
                self._send_json({"ok": True, "date": date_str})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, 500)
        else:
            self._send_json({"error": "Not Found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ============================================================
# 启动
# ============================================================

def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]; s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass

    parser = argparse.ArgumentParser(description="工作记录 Web 应用 (SQLite)")
    parser.add_argument("-p", "--port", type=int, default=8080, help="端口 (默认 8080)")
    parser.add_argument("-H", "--host", type=str, default="0.0.0.0", help="监听地址")
    args = parser.parse_args()

    # 自动迁移已有数据
    migrate_from_files()

    local_ip = get_local_ip()
    _safe_print("")
    _safe_print("=" * 56)
    _safe_print("  [Work Log] SQLite @ " + str(DB_PATH))
    _safe_print("=" * 56)
    _safe_print("")
    _safe_print("  Local:  http://localhost:" + str(args.port))
    _safe_print("  Mobile: http://" + local_ip + ":" + str(args.port))
    _safe_print("  Ctrl+C to stop")
    _safe_print("=" * 56)
    _safe_print("")

    server = HTTPServer((args.host, args.port), RequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _safe_print("Server stopped.")
        server.shutdown()

def _safe_print(text):
    try: print(text)
    except UnicodeEncodeError: print(text.encode("ascii", errors="replace").decode("ascii"))

if __name__ == "__main__":
    main()
