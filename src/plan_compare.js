// plan_compare.js - ორი კონტურის გეომეტრიული შედარება (გეგმიდან გამოთვლილი vs ოფიციალური რუკიდან).
// იყენებს: plan_test.js (გეგმების მასობრივი შემოწმება). DOM-ზე დამოკიდებული არ არის.
//
// კონტური = contours_core.js-ის polygons: [[გარე რგოლი, ...ხვრელები], ...]; რგოლი = [[გრძედი, განედი], ...].
// ყველა გამოთვლა ლოკალურ მეტრულ პროექციაშია (ცენტრის გარშემო): პატარა ნაკვეთზე ცდომილება უმნიშვნელოა.

const EARTH_RADIUS_METERS = 6371008.8;

const allRingsOf = (polygons) => polygons.flat();

function boundingBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// გრძედი/განედი -> მეტრები ცენტრიდან
function localProjection(centerLat, centerLon) {
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  return ([lon, lat]) => [(lon - centerLon) * Math.PI / 180 * EARTH_RADIUS_METERS * cosLat, (lat - centerLat) * Math.PI / 180 * EARTH_RADIUS_METERS];
}

// წერტილი შიგნითაა? (ლუწ-კენტის წესი: ხვრელი ავტომატურად გამოირიცხება)
function isInside(rings, x, y) {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function distanceToRings(point, rings) {
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) best = Math.min(best, distanceToSegment(point, ring[i], ring[(i + 1) % ring.length]));
  return best;
}

// საზღვრის წერტილები ყოველ `step` მეტრში (Hausdorff-ისთვის: მხოლოდ წვეროები საკმარისი არ არის)
function boundaryPoints(rings, step) {
  const points = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < pieces; k++) points.push([a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces]);
  }
  return points;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(sum / 2);
}

// ფართობი კვ.მ-ში (გარე რგოლები მინუს ხვრელები)
export function polygonsAreaSquareMeters(polygons) {
  const [minX, minY, maxX, maxY] = boundingBox(allRingsOf(polygons));
  const project = localProjection((minY + maxY) / 2, (minX + maxX) / 2);
  return polygons.reduce((total, [outer, ...holes]) =>
    total + ringArea(outer.map(project)) - holes.reduce((s, hole) => s + ringArea(hole.map(project)), 0), 0);
}

// შედარება: { iou, hausdorffMeters, meanDistanceMeters, shiftEastMeters, shiftNorthMeters }
//   iou            გადაფარვა / გაერთიანება (1 = იდენტური); ითვლება 300×300 ბადეზე
//   hausdorff      ყველაზე დიდი მანძილი ერთი საზღვრიდან მეორემდე
//   shift          სიმძიმის ცენტრების სხვაობა (სისტემატური წანაცვლება)
export function compareContours(planPolygons, officialPolygons) {
  const planRingsLonLat = allRingsOf(planPolygons), officialRingsLonLat = allRingsOf(officialPolygons);
  const [minX, minY, maxX, maxY] = boundingBox([...planRingsLonLat, ...officialRingsLonLat]);
  const project = localProjection((minY + maxY) / 2, (minX + maxX) / 2);
  const planRings = planRingsLonLat.map((ring) => ring.map(project));
  const officialRings = officialRingsLonLat.map((ring) => ring.map(project));
  const [x0, y0] = project([minX, minY]), [x1, y1] = project([maxX, maxY]);

  const GRID = 300, stepX = (x1 - x0) / GRID, stepY = (y1 - y0) / GRID;
  let intersection = 0, union = 0;
  const planCenter = [0, 0, 0], officialCenter = [0, 0, 0];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const x = x0 + (i + 0.5) * stepX, y = y0 + (j + 0.5) * stepY;
    const inPlan = isInside(planRings, x, y), inOfficial = isInside(officialRings, x, y);
    if (inPlan && inOfficial) intersection++;
    if (inPlan || inOfficial) union++;
    if (inPlan) { planCenter[0] += x; planCenter[1] += y; planCenter[2]++; }
    if (inOfficial) { officialCenter[0] += x; officialCenter[1] += y; officialCenter[2]++; }
  }

  const step = Math.max(0.02, Math.hypot(x1 - x0, y1 - y0) / 400);
  const distances = [
    ...boundaryPoints(planRings, step).map((p) => distanceToRings(p, officialRings)),
    ...boundaryPoints(officialRings, step).map((p) => distanceToRings(p, planRings))
  ];
  const haveCenters = planCenter[2] && officialCenter[2];
  return {
    iou: union ? intersection / union : 0,
    hausdorffMeters: Math.max(...distances),
    meanDistanceMeters: distances.reduce((s, d) => s + d, 0) / distances.length,
    shiftEastMeters: haveCenters ? planCenter[0] / planCenter[2] - officialCenter[0] / officialCenter[2] : NaN,
    shiftNorthMeters: haveCenters ? planCenter[1] / planCenter[2] - officialCenter[1] / officialCenter[2] : NaN
  };
}
