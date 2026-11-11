"""Regenerate the deterministic baseline fixtures.

Outputs (next to this file):
  sales.csv     200 daily rows (2024-01-01 .. 2024-07-18), one row per day
  stores.csv    5 stores, joinable on store_id
  baseline.xlsx sheets "sales" + "stores" (the file the driver uploads, so both
                tables live in ONE data source and can be joined)
  stores.html   the stores table as an HTML page (fetch_table fixture)
  baseline.sqlite  same two tables as a SQLite database (SQL-source scenario:
                get_table_detail / persistent analysis tables only work on SQL sources)

Deterministic content: fixed seed, no wall clock (the xlsx zip container still
stamps entry mtimes, so its bytes differ per regeneration; the cell data does not).
Requires openpyxl (in .venv).
Run: .venv/bin/python baseline/fixtures/make_fixtures.py
"""

from __future__ import annotations

import csv
import datetime as dt
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent

STORES = [
    ("S01", "Harbor Plaza", "East", 2015, 820),
    ("S02", "Pine Street", "North", 2017, 540),
    ("S03", "Sunset Mall", "West", 2019, 1100),
    ("S04", "Riverside", "South", 2012, 690),
    ("S05", "Old Town", "East", 2021, 410),
]
CATEGORIES = ["Electronics", "Furniture", "Office", "Apparel"]
SALES_HEADER = [
    "order_date", "store_id", "region", "category", "variant", "units",
    "unit_price", "discount", "ad_spend", "visitors", "converted", "revenue",
]


def build_sales() -> list[list]:
    rng = random.Random(20241103)
    start = dt.date(2024, 1, 1)
    rows = []
    for i in range(200):
        day = start + dt.timedelta(days=i)
        store = STORES[i % len(STORES)]
        category = CATEGORIES[(i * 7 + i // 5) % len(CATEGORIES)]
        variant = "A" if i % 2 == 0 else "B"
        ad_spend = round(200 + 150 * math.sin(i / 9.0) + rng.uniform(0, 120), 2)
        trend = 1.0 + i / 400.0
        weekly = 1.0 + 0.15 * math.sin(2 * math.pi * day.weekday() / 7.0)
        units = max(1, int(round((20 + ad_spend / 25.0) * trend * weekly + rng.gauss(0, 3))))
        unit_price = round(35 + 10 * CATEGORIES.index(category) + rng.uniform(-3, 3), 2)
        discount: float | str = round(rng.choice([0, 0.05, 0.1, 0.15]), 2)
        if i % 20 == 7:  # 10 missing values for clean_data fill_na
            discount = ""
        visitors = int(300 + ad_spend * 0.8 + rng.uniform(-20, 20))
        conv_rate = 0.10 if variant == "A" else 0.13
        converted = int(round(visitors * conv_rate + rng.gauss(0, 2)))
        revenue = round(units * unit_price * (1 - (discount or 0)), 2)
        if i in (41, 97, 163):  # outliers for winsorize / trimming
            revenue = round(revenue * 9, 2)
        rows.append([
            day.isoformat(), store[0], store[2], category, variant, units,
            unit_price, discount, ad_spend, visitors, converted, revenue,
        ])
    return rows


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def write_xlsx(path: Path, sheets: list[tuple[str, list[str], list[list]]]) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for title, header, rows in sheets:
        ws = wb.create_sheet(title)
        ws.append(header)
        for row in rows:
            ws.append([None if v == "" else v for v in row])
    # Pin document timestamps so the bytes are reproducible.
    fixed = dt.datetime(2024, 1, 1, 0, 0, 0)
    wb.properties.created = fixed
    wb.properties.modified = fixed
    wb.save(path)


def write_html(path: Path, header: list[str], rows: list[list]) -> None:
    head = "".join(f"<th>{h}</th>" for h in header)
    body = "\n".join(
        "<tr>" + "".join(f"<td>{v}</td>" for v in row) + "</tr>" for row in rows
    )
    path.write_text(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Stores</title></head>\n"
        f"<body><h1>Store directory</h1>\n<table>\n<thead><tr>{head}</tr></thead>\n"
        f"<tbody>\n{body}\n</tbody>\n</table></body></html>\n",
        encoding="utf-8",
    )


def write_sqlite(path: Path, sheets: list[tuple[str, list[str], list[list]]]) -> None:
    import sqlite3

    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    try:
        for title, header, rows in sheets:
            sample = rows[0]
            cols = ", ".join(
                f'"{h}" {"REAL" if isinstance(v, float) else "INTEGER" if isinstance(v, int) else "TEXT"}'
                for h, v in zip(header, sample)
            )
            conn.execute(f'CREATE TABLE "{title}" ({cols})')
            marks = ", ".join("?" for _ in header)
            conn.executemany(
                f'INSERT INTO "{title}" VALUES ({marks})',
                [[None if v == "" else v for v in row] for row in rows],
            )
        conn.commit()
    finally:
        conn.close()


def main() -> None:
    sales = build_sales()
    stores_header = ["store_id", "store_name", "region", "opened_year", "floor_sqm"]
    stores = [list(s) for s in STORES]
    sheets = [("sales", SALES_HEADER, sales), ("stores", stores_header, stores)]
    write_csv(HERE / "sales.csv", SALES_HEADER, sales)
    write_csv(HERE / "stores.csv", stores_header, stores)
    write_xlsx(HERE / "baseline.xlsx", sheets)
    write_sqlite(HERE / "baseline.sqlite", sheets)
    write_html(HERE / "stores.html", stores_header, stores)
    print(f"wrote {len(sales)} sales rows, {len(stores)} stores -> {HERE}")


if __name__ == "__main__":
    main()
