import geopandas as gpd

shelters = gpd.read_file("skyddsrum.geojson")
kommuner = gpd.read_file("kommun_shapes/kommun/Kommun_Sweref99TM.shp")

shelters_proj = shelters.to_crs(kommuner.crs)

# Pass 1: exact "within" join
joined = gpd.sjoin(shelters_proj, kommuner, how="left", predicate="within")

# Pass 2: for anything unmatched, snap to the nearest municipality polygon
unmatched_mask = joined["KnNamn"].isna()
print(f"Unmatched after pass 1: {unmatched_mask.sum()}")

if unmatched_mask.sum() > 0:
    unmatched_pts = shelters_proj.loc[unmatched_mask]
    nearest = gpd.sjoin_nearest(unmatched_pts, kommuner, how="left")
    
    # Fill in the gaps using the nearest-match results
    joined.loc[unmatched_mask, "KnNamn"] = nearest["KnNamn"].values
    joined.loc[unmatched_mask, "KnKod"] = nearest["KnKod"].values

still_unmatched = joined["KnNamn"].isna().sum()
print(f"Unmatched after pass 2: {still_unmatched}")

# Build address string
joined["full_address"] = (
    joined["additionallocationdescription"].fillna("").str.strip()
    + ", "
    + joined["KnNamn"].fillna("")
)
joined["full_address"] = joined["full_address"].str.lstrip(", ").str.strip()

joined = joined.to_crs("EPSG:4326")
joined.to_file("skyddsrum_enriched.geojson", driver="GeoJSON")

print(joined[["name", "full_address", "numberofoccupants", "KnNamn"]].head(10))