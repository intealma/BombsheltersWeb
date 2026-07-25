import json
from collections import Counter

with open("skyddsrum.geojson", encoding="utf-8") as f:
    data = json.load(f)

feats = data["features"]
key_counts = Counter()
non_empty_counts = Counter()

for feat in feats:
    props = feat["properties"]
    for k, v in props.items():
        key_counts[k] += 1
        if v not in (None, "", "null"):
            non_empty_counts[k] += 1

print(f"{'field':35s} {'present':>10s} {'non-empty':>10s}")
for k in key_counts:
    print(f"{k:35s} {key_counts[k]:10d} {non_empty_counts[k]:10d}")