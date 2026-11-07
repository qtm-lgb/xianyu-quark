# -*- coding: utf-8 -*-
"""把已上架商品写入 Ydisks 的 item_info 表（需先停服务）"""
import sqlite3, json, sys, os

DB = r"C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db"
ACCOUNT = "2419336374"
DATA = sys.argv[1]

with open(DATA, 'r', encoding='utf-8') as f:
    rows = json.load(f)

c = sqlite3.connect(DB, timeout=30)
c.execute("PRAGMA busy_timeout=30000")
cur = c.cursor()

# 确认可写
print("journal_mode:", cur.execute("PRAGMA journal_mode").fetchone()[0])

detail = '{"auction_type":"b","card_type":1003}'
inserted = updated = 0
for r in rows:
    item_id = str(r["item_id"])
    title = r["title"]
    exists = cur.execute(
        "SELECT id FROM item_info WHERE cookie_id=? AND item_id=?", (ACCOUNT, item_id)
    ).fetchone()
    if exists:
        cur.execute(
            "UPDATE item_info SET item_title=?, item_price=?, item_category=?, deleted_at=NULL, updated_at=datetime('now','localtime') WHERE id=?",
            (title, r.get("price", "¥1.90"), r.get("category", "50023914"), exists[0]),
        )
        updated += 1
    else:
        cur.execute(
            "INSERT INTO item_info (cookie_id,item_id,item_title,item_description,item_category,item_price,item_detail,is_multi_spec,multi_quantity_delivery,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,0,0,datetime('now','localtime'),datetime('now','localtime'))",
            (ACCOUNT, item_id, title, None, r.get("category", "50023914"), r.get("price", "¥1.90"), detail),
        )
        inserted += 1

c.commit()
total = cur.execute(
    "SELECT COUNT(*) FROM item_info WHERE cookie_id=? AND deleted_at IS NULL", (ACCOUNT,)
).fetchone()[0]
print(f"OK inserted={inserted} updated={updated} total_active={total}")
c.close()
