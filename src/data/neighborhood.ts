// 道路の中心線・幅・標高。接続点を共有し、実際に再合流する迂回路を作る。
export type RoadPoint = [x: number, y: number, z: number];
export type StreetKind = "main" | "residential" | "alley" | "park";
export interface StreetDef {
  id: string;
  from: string;
  to: string;
  width: number;
  sidewalk: number;
  kind: StreetKind;
  via: RoadPoint[];
}
export const NEIGHBORHOOD_HALF = 200;
export const NODES: Record<string, RoadPoint> = {
  westGate: [-52, 0, -18], bend: [-5, 0.6, -8], eastGate: [48, 2.6, 4],
  parkWest: [-43, 0.3, 36], parkEast: [12, 1.5, 53], parkFork: [-1, 0.8, 15],
};
// 先に約100mの通りと公園の迂回路を検証する。400m版でもこの区間をそのまま使う。
export const PILOT_STREETS: StreetDef[] = [
  { id: "shopping-west", from: "westGate", to: "bend", width: 8, sidewalk: 1.7, kind: "main", via: [[-29, 0.2, -17]] },
  { id: "shopping-east", from: "bend", to: "eastGate", width: 8, sidewalk: 1.7, kind: "main", via: [[23, 1.7, 1]] },
  { id: "park-lane-west", from: "westGate", to: "parkWest", width: 4.6, sidewalk: 0, kind: "residential", via: [[-58, 0, 9]] },
  { id: "garden-lane", from: "parkWest", to: "parkEast", width: 4.6, sidewalk: 0, kind: "residential", via: [[-22, 0.7, 49]] },
  { id: "sakura-slope", from: "parkEast", to: "eastGate", width: 4.8, sidewalk: 0, kind: "residential", via: [[38, 2.2, 38]] },
  { id: "park-entry", from: "bend", to: "parkFork", width: 3, sidewalk: 0, kind: "park", via: [[-7, 0.65, 4]] },
  { id: "park-path", from: "parkFork", to: "parkEast", width: 2.8, sidewalk: 0, kind: "park", via: [[-11, 1, 32]] },
  { id: "park-crossing", from: "parkWest", to: "parkFork", width: 2.6, sidewalk: 0, kind: "park", via: [[-27, 0.5, 29]] },
];
// 100mの歩行・接地・衝突検証後に追加した400m地区。谷筋と尾根を結ぶ長短のループ。
export const DISTRICT_NODES: Record<string, RoadPoint> = {
  westJ: [-124,0,-35], westEnd: [-194,-.4,-63], northwest: [-155,1.2,73], ridgeWest: [-86,2,143],
  ridge: [-12,4.2,174], estate: [119,7.8,152], eastMid: [134,6.7,61], eastJ: [116,5.2,-18], eastEnd: [194,8.3,19],
  southEast: [112,4.3,-96], south: [33,2.1,-171], southWest: [-73,.1,-141], southwest: [-143,-.1,-116],
  westLane: [-94,.5,20], northLane: [35,3.1,110], eastGarden: [74,4,76],
  southCross: [1,.7,-73], southLane: [-37,.3,-104], southInner: [64,2.8,-61],
};
export const DISTRICT_STREETS: StreetDef[] = [
  {id:"west-shopping",from:"westJ",to:"westGate",width:8,sidewalk:1.6,kind:"main",via:[[-85,0,-22]]},
  {id:"west-approach",from:"westEnd",to:"westJ",width:8,sidewalk:1.6,kind:"main",via:[[-170,-.2,-56]]},
  {id:"east-shopping",from:"eastGate",to:"eastJ",width:8,sidewalk:1.6,kind:"main",via:[[82,4,-12]]},
  {id:"east-approach",from:"eastJ",to:"eastEnd",width:8,sidewalk:1.6,kind:"main",via:[[155,6.8,-8]]},
  {id:"garden-slope",from:"eastGate",to:"eastGarden",width:5.4,sidewalk:0,kind:"residential",via:[[63,3.1,35]]},
  {id:"east-estate-south",from:"eastGarden",to:"eastMid",width:5.8,sidewalk:1.2,kind:"residential",via:[[106,5.4,80]]},
  {id:"estate-hill",from:"eastMid",to:"estate",width:6,sidewalk:1.2,kind:"residential",via:[[149,7.5,123]]},
  {id:"ridge-road",from:"estate",to:"ridge",width:6,sidewalk:1.2,kind:"residential",via:[[73,7.4,178],[31,5.6,169]]},
  {id:"ridge-houses",from:"ridge",to:"ridgeWest",width:5.4,sidewalk:0,kind:"residential",via:[[-52,3,167]]},
  {id:"west-hill",from:"ridgeWest",to:"northwest",width:4.6,sidewalk:0,kind:"residential",via:[[-126,1.4,132],[-162,1.1,102]]},
  {id:"old-valley",from:"northwest",to:"westJ",width:5.2,sidewalk:0,kind:"residential",via:[[-171,.6,22],[-148,.2,-8]]},
  {id:"narrow-west",from:"northwest",to:"westLane",width:3.5,sidewalk:0,kind:"alley",via:[[-124,.7,45]]},
  {id:"park-approach",from:"westLane",to:"parkWest",width:4.5,sidewalk:0,kind:"residential",via:[[-70,.35,45]]},
  {id:"west-dogleg",from:"westLane",to:"westGate",width:3.4,sidewalk:0,kind:"alley",via:[[-79,.1,-4]]},
  {id:"north-houses",from:"ridgeWest",to:"northLane",width:5.2,sidewalk:0,kind:"residential",via:[[-22,2.7,123]]},
  {id:"estate-court",from:"northLane",to:"estate",width:5.4,sidewalk:1.2,kind:"residential",via:[[75,5.5,132]]},
  {id:"greenway",from:"parkEast",to:"northLane",width:2.8,sidewalk:0,kind:"park",via:[[26,2.1,85]]},
  {id:"estate-garden-path",from:"northLane",to:"eastGarden",width:3,sidewalk:0,kind:"park",via:[[57,3.7,96]]},
  {id:"east-backstreet",from:"eastGarden",to:"eastJ",width:4.8,sidewalk:0,kind:"residential",via:[[94,4.8,25]]},
  {id:"south-company",from:"eastJ",to:"southEast",width:6,sidewalk:1.2,kind:"residential",via:[[123,4.8,-63]]},
  {id:"south-east-houses",from:"southEast",to:"south",width:5.4,sidewalk:0,kind:"residential",via:[[84,3.8,-149]]},
  {id:"south-loop",from:"south",to:"southWest",width:5.4,sidewalk:0,kind:"residential",via:[[-23,1.1,-180]]},
  {id:"southwest-houses",from:"southWest",to:"westJ",width:5.2,sidewalk:0,kind:"residential",via:[[-107,0,-102]]},
  {id:"western-detour",from:"westEnd",to:"southwest",width:4.6,sidewalk:0,kind:"residential",via:[[-186,-.2,-96]]},
  {id:"southwest-alley",from:"southwest",to:"southWest",width:3.5,sidewalk:0,kind:"alley",via:[[-119,-.2,-151]]},
  {id:"south-park-lane",from:"westGate",to:"southLane",width:4.5,sidewalk:0,kind:"residential",via:[[-63,0,-55]]},
  {id:"south-lane-link",from:"southLane",to:"southWest",width:3.4,sidewalk:0,kind:"alley",via:[[-55,.1,-122]]},
  {id:"staggered-t",from:"southLane",to:"southCross",width:3.5,sidewalk:0,kind:"alley",via:[[-23,.6,-78]]},
  {id:"south-middle",from:"southCross",to:"southInner",width:5.2,sidewalk:0,kind:"residential",via:[[30,1.7,-65]]},
  {id:"company-backlane",from:"southInner",to:"eastJ",width:4.6,sidewalk:0,kind:"residential",via:[[91,3.9,-34]]},
  {id:"south-court",from:"southLane",to:"south",width:4.6,sidewalk:0,kind:"residential",via:[[-10,1,-139]]},
  {id:"east-dogleg",from:"southInner",to:"southEast",width:3.2,sidewalk:0,kind:"alley",via:[[99,3.9,-73]]},
  {id:"central-south",from:"southCross",to:"bend",width:5.4,sidewalk:0,kind:"residential",via:[[-13,.6,-37]]},
];
export const BUILDING_PALETTES = {
  house: ["building_001", "building_002", "building_004", "building_006", "building_011", "building_013", "building_018", "building_023", "building_030"],
  apartment: ["building_031", "building_032", "building_037", "building_042", "building_051"],
  estate: ["building_033", "building_034", "building_050"],
  company: ["building_056", "building_067", "building_066"],
  shop: ["shop_015", "shop_020", "shop_031", "shop_036", "shop_039", "shop_041", "shop_054"],
};
