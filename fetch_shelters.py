import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import json
import time

BASE = "https://inspire.msb.se/geoserver/skyddsrum/wfs"
TYPE_NAME = "skyddsrum:US_civilProtectionSite"
PAGE_SIZE = 2000  # smaller pages = less likely to get cut off

session = requests.Session()
retries = Retry(
    total=5,
    backoff_factor=2,          # waits 2s, 4s, 8s, 16s, 32s between retries
    status_forcelist=[500, 502, 503, 504],
)
session.mount("https://", HTTPAdapter(max_retries=retries))

all_features = []
start = 0

while True:
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": TYPE_NAME,
        "outputFormat": "application/json",
        "count": PAGE_SIZE,
        "startIndex": start,
        "srsName": "EPSG:4326",
    }

    for attempt in range(5):
        try:
            r = session.get(BASE, params=params, timeout=120)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.exceptions.ChunkedEncodingError,
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            print(f"  retry {attempt+1}/5 after error: {e}")
            time.sleep(3)
    else:
        print("Giving up on this page after 5 attempts.")
        break

    feats = data.get("features", [])
    print(f"Fetched {len(feats)} features (startIndex={start})")
    if not feats:
        break

    all_features.extend(feats)
    start += PAGE_SIZE

    if len(feats) < PAGE_SIZE:
        break

print(f"\nTotal shelters: {len(all_features)}")

geojson = {"type": "FeatureCollection", "features": all_features}
with open("skyddsrum.geojson", "w", encoding="utf-8") as f:
    json.dump(geojson, f, ensure_ascii=False)

print("Saved to skyddsrum.geojson")