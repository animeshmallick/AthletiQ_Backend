const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres between two WGS84 coordinates (haversine formula). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Maximum GPS accuracy (metres) credited when judging a reading; stops a vague fix "proving" presence. */
const MAX_ACCURACY_TOLERANCE_M = 100;

/**
 * A reading counts as inside the geofence if its distance minus the reported GPS accuracy
 * (capped) is within the radius.
 */
export function isWithinGeofence(
  distanceM: number,
  radiusM: number,
  accuracyM?: number | null,
): boolean {
  const tolerance = Math.min(Math.max(accuracyM ?? 0, 0), MAX_ACCURACY_TOLERANCE_M);
  return distanceM - tolerance <= radiusM;
}
