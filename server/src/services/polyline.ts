export function decodePolyline(encoded: string): Array<{lat:number,lng:number}> {
  let index=0, lat=0, lng=0; const points:Array<{lat:number,lng:number}>=[];
  while(index<encoded.length){
    let b=0, shift=0, result=0;
    do { b=encoded.charCodeAt(index++)-63; result|=(b&31)<<shift; shift+=5; } while(b>=32);
    lat += (result&1) ? ~(result>>1) : result>>1;
    shift=0; result=0;
    do { b=encoded.charCodeAt(index++)-63; result|=(b&31)<<shift; shift+=5; } while(b>=32);
    lng += (result&1) ? ~(result>>1) : result>>1;
    points.push({lat:lat/1e5,lng:lng/1e5});
  }
  return points;
}

function pointInRing(point:{lat:number,lng:number}, ring:number[][]) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    const hit=((yi>point.lat)!==(yj>point.lat)) && point.lng < (xj-xi)*(point.lat-yi)/(yj-yi)+xi;
    if(hit) inside=!inside;
  }
  return inside;
}

export function pointInGeometry(point:{lat:number,lng:number}, geometry:any) {
  if(geometry.type === "Polygon") return pointInRing(point, geometry.coordinates[0].map((p:number[])=>[p[0],p[1]]));
  if(geometry.type === "MultiPolygon") return geometry.coordinates.some((poly:number[][][])=>pointInRing(point, poly[0].map((p:number[])=>[p[0],p[1]])));
  return false;
}
