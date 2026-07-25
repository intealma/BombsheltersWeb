import json

with open("skyddsrum_enriched.geojson", encoding="utf-8") as f:
    data = json.load(f)

trimmed = {"type": "FeatureCollection", "features": []}

for feat in data["features"]:
    props = feat["properties"]
    coords = feat["geometry"]["coordinates"]
    trimmed["features"].append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coords},
        "properties": {
            "id": props.get("name", ""),
            "address": props.get("full_address", "").strip(", ") or "Adress saknas",
            "capacity": props.get("numberofoccupants", 0),
            "municipality": props.get("KnNamn", ""),
        }
    })

with open("shelters.geojson", "w", encoding="utf-8") as f:
    json.dump(trimmed, f, ensure_ascii=False, separators=(",", ":"))

print(f"Trimmed {len(trimmed['features'])} shelters")