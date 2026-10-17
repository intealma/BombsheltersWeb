"""Write shelter capacities from shelters.geojson as a CSV for the `shelter_capacity` table.

The database needs capacities to turn headcounts into the coarse public level
("filling" / "full"); see "Public occupancy" in schema.sql.

    python supabase/build_capacity_csv.py

Then in Supabase: Table Editor -> shelter_capacity -> Insert -> Import data from CSV,
and pick supabase/shelter_capacity.csv (gitignored). To refresh after a new
shelters.geojson, first run `truncate shelter_capacity;` in the SQL editor.
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "shelters.geojson"
OUT = Path(__file__).resolve().parent / "shelter_capacity.csv"

features = json.loads(SRC.read_text(encoding="utf-8"))["features"]
rows = {}
for f in features:
    props = f["properties"]
    shelter_id, capacity = props.get("id"), props.get("capacity")
    if shelter_id and isinstance(capacity, int) and capacity > 0:
        rows[shelter_id] = capacity

with OUT.open("w", encoding="utf-8", newline="") as fh:
    writer = csv.writer(fh)
    writer.writerow(["shelter_id", "capacity"])
    writer.writerows(sorted(rows.items()))

print(f"Wrote {len(rows)} of {len(features)} shelters to {OUT.relative_to(ROOT)}")
